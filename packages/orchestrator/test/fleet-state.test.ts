import { assert, describe, it } from "@effect/vitest";
import {
  AttemptId,
  JobNack,
  RequestId,
  WorkerHealthSnapshot,
  WorkerId,
  WorkerRegistration,
} from "@lambda-fluid/protocol";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  addWorker,
  applyNack,
  emptyFleet,
  RoutingPolicy,
  selectAndReserve,
  type FleetState,
  type FleetTransitionError,
} from "../src/fleet-state.js";
import { makeFleetRegistry } from "../src/fleet-registry.js";
import {
  applySnapshot,
  isEligible,
  makeWorkerState,
  type WorkerState,
  type WorkerTransitionError,
} from "../src/worker-state.js";

const requestA = RequestId.make("request-a");
const requestB = RequestId.make("request-b");
const attemptA = AttemptId.make("attempt-a");
const attemptB = AttemptId.make("attempt-b");

const unwrapWorker = (
  result: Result.Result<WorkerState, WorkerTransitionError>
): WorkerState => {
  if (Result.isFailure(result)) {
    assert.fail(`Expected worker transition success: ${result.failure.reason}`);
  }
  return result.success;
};

const unwrapFleet = (
  result: Result.Result<FleetState, FleetTransitionError>
): FleetState => {
  if (Result.isFailure(result)) {
    assert.fail(`Expected fleet transition success: ${result.failure.reason}`);
  }
  return result.success;
};

const worker = (name: string, inFlight: number, snapshotSequence = 1): WorkerState => {
  const workerId = WorkerId.make(name);
  return unwrapWorker(
    makeWorkerState(
      WorkerRegistration.make({
        protocolVersion: 1,
        workerId,
        maxConcurrency: 10,
        connectionGeneration: 1,
        invocationDeadlineEpochMs: 900_000,
      }),
      WorkerHealthSnapshot.make({
        workerId,
        connectionGeneration: 1,
        snapshotSequence,
        sampledAtEpochMs: snapshotSequence * 1_000,
        inFlight,
        inFlightHighWater: inFlight,
        cpuUsedMicros: 10_000,
        sampleIntervalMicros: 100_000,
        rssBytes: 300_000_000,
        heapUsedBytes: 100_000_000,
        memoryLimitBytes: 1_000_000_000,
        eventLoopLagMicros: 1_000,
        admissionState: "Accepting",
      })
    )
  );
};

const fleetOf = (...workers: ReadonlyArray<WorkerState>): FleetState => {
  let fleet = emptyFleet();
  for (const state of workers) {
    fleet = unwrapFleet(addWorker(fleet, state));
  }
  return fleet;
};

const nextSnapshot = (
  previous: WorkerHealthSnapshot,
  overrides: Partial<WorkerHealthSnapshot>
): WorkerHealthSnapshot =>
  WorkerHealthSnapshot.make({
    workerId: previous.workerId,
    connectionGeneration: previous.connectionGeneration,
    snapshotSequence: previous.snapshotSequence,
    sampledAtEpochMs: previous.sampledAtEpochMs,
    inFlight: previous.inFlight,
    inFlightHighWater: previous.inFlightHighWater,
    cpuUsedMicros: previous.cpuUsedMicros,
    sampleIntervalMicros: previous.sampleIntervalMicros,
    rssBytes: previous.rssBytes,
    heapUsedBytes: previous.heapUsedBytes,
    memoryLimitBytes: previous.memoryLimitBytes,
    eventLoopLagMicros: previous.eventLoopLagMicros,
    admissionState: previous.admissionState,
    ...overrides,
  });

describe("fleet admission state", () => {
  it("packs into the eligible worker with the smallest positive headroom", () => {
    const fuller = worker("worker-fuller", 4);
    const initialEmptier = worker("worker-emptier", 1);
    const emptier = unwrapWorker(
      applySnapshot(
        initialEmptier,
        nextSnapshot(initialEmptier.snapshot, {
          snapshotSequence: 2,
          sampledAtEpochMs: 2_000,
          inFlightHighWater: 2,
        })
      )
    );
    const fleet = fleetOf(fuller, emptier);

    const transition = selectAndReserve(
      fleet,
      requestA,
      attemptA,
      2_000,
      RoutingPolicy.Pack()
    );
    if (Result.isFailure(transition)) {
      assert.fail(`Expected selection success: ${transition.failure.reason}`);
    }

    assert.strictEqual(transition.success.selection.workerId, fuller.workerId);
  });

  it("spreads onto the worker with the lowest normalized utilization", () => {
    const fuller = worker("worker-fuller", 4);
    const initialEmptier = worker("worker-emptier", 1);
    const emptier = unwrapWorker(
      applySnapshot(
        initialEmptier,
        nextSnapshot(initialEmptier.snapshot, {
          snapshotSequence: 2,
          sampledAtEpochMs: 2_000,
          inFlightHighWater: 2,
        })
      )
    );

    const transition = selectAndReserve(
      fleetOf(fuller, emptier),
      requestA,
      attemptA,
      2_000,
      RoutingPolicy.Spread()
    );
    if (Result.isFailure(transition)) {
      assert.fail(`Expected selection success: ${transition.failure.reason}`);
    }

    assert.strictEqual(transition.success.selection.workerId, emptier.workerId);
  });

  it("suppresses a worker after a capacity nack and restores it on newer healthy evidence", () => {
    const initialWorker = worker("worker-1", 0);
    const reserved = selectAndReserve(
      fleetOf(initialWorker),
      requestA,
      attemptA,
      2_000,
      RoutingPolicy.Pack()
    );
    if (Result.isFailure(reserved)) {
      assert.fail(`Expected reservation success: ${reserved.failure.reason}`);
    }

    const nacked = applyNack(
      reserved.success.fleet,
      JobNack.make({
        requestId: requestA,
        attemptId: attemptA,
        workerId: initialWorker.workerId,
        connectionGeneration: 1,
        reason: "AtCapacity",
        nackedAtEpochMs: 2_001,
      })
    );
    if (Result.isFailure(nacked)) {
      assert.fail(`Expected nack success: ${nacked.failure.reason}`);
    }

    const suppressed = nacked.success.fleet.workers.get(initialWorker.workerId);
    assert.isDefined(suppressed);
    assert.isFalse(isEligible(suppressed));

    const recovered = unwrapWorker(
      applySnapshot(
        suppressed,
        nextSnapshot(suppressed.snapshot, {
          snapshotSequence: 2,
          sampledAtEpochMs: 3_000,
        })
      )
    );
    assert.isTrue(isEligible(recovered));
  });

  it("keeps draining terminal and removes an internally broken worker", () => {
    const initialWorker = worker("worker-1", 0);
    const first = selectAndReserve(
      fleetOf(initialWorker),
      requestA,
      attemptA,
      2_000,
      RoutingPolicy.Pack()
    );
    if (Result.isFailure(first)) assert.fail(first.failure.reason);
    const draining = applyNack(
      first.success.fleet,
      JobNack.make({
        requestId: requestA,
        attemptId: attemptA,
        workerId: initialWorker.workerId,
        connectionGeneration: 1,
        reason: "Draining",
        nackedAtEpochMs: 2_001,
      })
    );
    if (Result.isFailure(draining)) assert.fail(draining.failure.reason);

    const drainedWorker = draining.success.fleet.workers.get(initialWorker.workerId);
    assert.isDefined(drainedWorker);
    const later = unwrapWorker(
      applySnapshot(
        drainedWorker,
        nextSnapshot(drainedWorker.snapshot, {
          snapshotSequence: 2,
          sampledAtEpochMs: 3_000,
          admissionState: "Accepting",
        })
      )
    );
    assert.isFalse(isEligible(later));

    const secondWorker = worker("worker-2", 0);
    const second = selectAndReserve(
      fleetOf(secondWorker),
      requestB,
      attemptB,
      2_000,
      RoutingPolicy.Pack()
    );
    if (Result.isFailure(second)) assert.fail(second.failure.reason);
    const broken = applyNack(
      second.success.fleet,
      JobNack.make({
        requestId: requestB,
        attemptId: attemptB,
        workerId: secondWorker.workerId,
        connectionGeneration: 1,
        reason: "Internal",
        nackedAtEpochMs: 2_001,
      })
    );
    if (Result.isFailure(broken)) assert.fail(broken.failure.reason);
    assert.isFalse(broken.success.fleet.workers.has(secondWorker.workerId));
    assert.strictEqual(broken.success.directive._tag, "DisconnectWorker");
  });

  it.effect(
    "atomically prevents concurrent routing fibers from claiming one slot",
    () =>
      Effect.gen(function* () {
        const onlyWorker = worker("worker-1", 0);
        const registry = yield* makeFleetRegistry(fleetOf(onlyWorker));

        const outcomes = yield* Effect.all(
          [
            Effect.result(
              registry.selectAndReserve(requestA, attemptA, 2_000, RoutingPolicy.Pack())
            ),
            Effect.result(
              registry.selectAndReserve(requestB, attemptB, 2_000, RoutingPolicy.Pack())
            ),
          ],
          { concurrency: "unbounded" }
        );

        assert.strictEqual(outcomes.filter(Result.isSuccess).length, 1);
        assert.strictEqual(outcomes.filter(Result.isFailure).length, 1);
        const fleet = yield* registry.snapshot;
        assert.strictEqual(fleet.workers.get(onlyWorker.workerId)?.assignments.size, 1);
      })
  );
});
