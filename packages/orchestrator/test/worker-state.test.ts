import { assert, describe, it } from "@effect/vitest";

import {
  AttemptId,
  RequestId,
  WorkerHealthSnapshot,
  WorkerId,
  WorkerRegistration,
} from "@lambda-fluid/protocol";
import * as Result from "effect/Result";

import {
  accept,
  admissionLimit,
  applySnapshot,
  effectiveLoad,
  isEligible,
  makeWorkerState,
  release,
  reserve,
  suppress,
  type TransitionResult,
  type WorkerState,
} from "../src/worker-state.js";

const workerId = WorkerId.make("worker-1");
const requestA = RequestId.make("request-a");
const requestB = RequestId.make("request-b");
const attemptA = AttemptId.make("attempt-a");
const attemptB = AttemptId.make("attempt-b");

const registration = WorkerRegistration.make({
  protocolVersion: 1,
  workerId,
  maxConcurrency: 10,
  connectionGeneration: 1,
  invocationDeadlineEpochMs: 900_000,
});

const snapshot = (
  overrides: Partial<WorkerHealthSnapshot> = {}
): WorkerHealthSnapshot =>
  WorkerHealthSnapshot.make({
    workerId,
    connectionGeneration: 1,
    snapshotSequence: 1,
    sampledAtEpochMs: 1_000,
    inFlight: 7,
    inFlightHighWater: 7,
    cpuUsedMicros: 10_000,
    sampleIntervalMicros: 100_000,
    rssBytes: 300_000_000,
    heapUsedBytes: 100_000_000,
    memoryLimitBytes: 1_000_000_000,
    eventLoopLagMicros: 1_000,
    admissionState: "Accepting",
    ...overrides,
  });

const success = (result: TransitionResult): WorkerState => {
  if (Result.isFailure(result)) {
    assert.fail(`Expected transition success, received ${result.failure.reason}`);
  }
  return result.success;
};

describe("worker admission state", () => {
  it("tracks reservations over a stale worker snapshot", () => {
    let state = success(makeWorkerState(registration, snapshot()));
    assert.strictEqual(effectiveLoad(state), 7);

    state = success(
      applySnapshot(
        state,
        snapshot({
          snapshotSequence: 2,
          sampledAtEpochMs: 1_050,
          inFlightHighWater: 8,
        })
      )
    );
    assert.strictEqual(admissionLimit(state), 9);

    state = success(reserve(state, requestA, attemptA, 1_100));
    state = success(reserve(state, requestB, attemptB, 1_101));
    assert.strictEqual(effectiveLoad(state), 9);

    state = success(accept(state, requestA, attemptA, 1_102));
    state = success(release(state, requestB, attemptB));
    assert.strictEqual(effectiveLoad(state), 8);
  });

  it("reconciles an accepted assignment with a newer snapshot", () => {
    let state = success(makeWorkerState(registration, snapshot()));
    state = success(reserve(state, requestA, attemptA, 1_100));
    state = success(accept(state, requestA, attemptA, 1_102));
    assert.strictEqual(effectiveLoad(state), 8);

    state = success(
      applySnapshot(
        state,
        snapshot({
          snapshotSequence: 2,
          sampledAtEpochMs: 1_200,
          inFlight: 8,
        })
      )
    );

    assert.strictEqual(state.assignments.size, 0);
    assert.strictEqual(effectiveLoad(state), 8);
  });

  it("rejects stale snapshots and prevents over-reservation", () => {
    let state = success(
      makeWorkerState(registration, snapshot({ snapshotSequence: 2, inFlight: 9 }))
    );

    state = success(reserve(state, requestA, attemptA, 1_100));

    const atCapacity = reserve(state, requestB, attemptB, 1_101);
    if (Result.isSuccess(atCapacity)) {
      assert.fail("Expected reservation to fail at capacity");
    }
    assert.strictEqual(atCapacity.failure.reason, "AtCapacity");

    const stale = applySnapshot(state, snapshot({ snapshotSequence: 1, inFlight: 1 }));
    if (Result.isSuccess(stale)) {
      assert.fail("Expected stale snapshot to fail");
    }
    assert.strictEqual(stale.failure.reason, "StaleSnapshot");
    assert.strictEqual(effectiveLoad(state), 10);
  });

  it("rejects new reservations after a worker begins draining", () => {
    const state = success(
      makeWorkerState(registration, snapshot({ admissionState: "Draining" }))
    );

    const result = reserve(state, requestA, attemptA, 1_100);
    if (Result.isSuccess(result)) {
      assert.fail("Expected a draining worker to reject the reservation");
    }
    assert.strictEqual(result.failure.reason, "Draining");
  });

  it("increases admission only after healthy utilization reaches the current limit", () => {
    let state = success(
      makeWorkerState(registration, snapshot({ inFlight: 0, inFlightHighWater: 0 }))
    );
    assert.strictEqual(admissionLimit(state), 1);

    state = success(
      applySnapshot(
        state,
        snapshot({
          snapshotSequence: 2,
          sampledAtEpochMs: 2_000,
          inFlight: 0,
          inFlightHighWater: 0,
        })
      )
    );
    assert.strictEqual(admissionLimit(state), 1);

    state = success(
      applySnapshot(
        state,
        snapshot({
          snapshotSequence: 3,
          sampledAtEpochMs: 3_000,
          inFlight: 1,
          inFlightHighWater: 1,
        })
      )
    );
    assert.strictEqual(admissionLimit(state), 2);
  });

  it("halves the admission limit when a worker reports CPU pressure", () => {
    let state = success(makeWorkerState(registration, snapshot({ inFlight: 3 })));
    assert.strictEqual(admissionLimit(state), 4);

    state = success(
      applySnapshot(
        state,
        snapshot({
          snapshotSequence: 2,
          sampledAtEpochMs: 2_000,
          inFlight: 4,
          inFlightHighWater: 4,
          cpuUsedMicros: 80_000,
        })
      )
    );

    assert.strictEqual(admissionLimit(state), 2);
    assert.strictEqual(effectiveLoad(state), 4);
    assert.isFalse(isEligible(state));

    state = success(
      applySnapshot(
        state,
        snapshot({
          snapshotSequence: 3,
          sampledAtEpochMs: 3_000,
          inFlight: 1,
          inFlightHighWater: 1,
        })
      )
    );
    assert.isTrue(isEligible(state));
    assert.strictEqual(admissionLimit(state), 2);
    assert.strictEqual(effectiveLoad(state), 1);
  });

  it("backs off only once when concurrent nacks share one snapshot", () => {
    const state = success(makeWorkerState(registration, snapshot({ inFlight: 7 })));

    const first = suppress(state, "AtCapacity");
    const second = suppress(first, "AtCapacity");

    assert.strictEqual(admissionLimit(first), 4);
    assert.strictEqual(admissionLimit(second), 4);
  });
});
