import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DeploymentId,
  RequestId,
  WorkerHealthSnapshot,
  WorkerId,
  WorkerRegistration,
} from "@lambda-fluid/protocol";
import { Result } from "effect";

import {
  accept,
  applySnapshot,
  effectiveLoad,
  makeWorkerState,
  release,
  reserve,
  type TransitionResult,
  type WorkerState,
} from "../src/worker-state.js";

const workerId = WorkerId.make("worker-1");
const deploymentId = DeploymentId.make("deployment-1");
const requestA = RequestId.make("request-a");
const requestB = RequestId.make("request-b");

const registration = WorkerRegistration.make({
  protocolVersion: 1,
  workerId,
  deploymentId,
  maxConcurrency: 10,
  connectionGeneration: 1,
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
    cpuUsedMicros: 10_000,
    sampleIntervalMicros: 100_000,
    rssBytes: 300_000_000,
    heapUsedBytes: 100_000_000,
    memoryLimitBytes: 1_000_000_000,
    eventLoopLagMicros: 1_000,
    draining: false,
    ...overrides,
  });

const success = (result: TransitionResult): WorkerState => {
  assert(Result.isSuccess(result));
  return result.success;
};

describe("worker admission state", () => {
  it("tracks reservations over a stale worker snapshot", () => {
    let state = success(makeWorkerState(registration, snapshot()));
    assert.equal(effectiveLoad(state), 7);

    state = success(reserve(state, requestA, 1_100));
    state = success(reserve(state, requestB, 1_101));
    assert.equal(effectiveLoad(state), 9);

    state = success(accept(state, requestA, 1_102));
    state = success(release(state, requestB));
    assert.equal(effectiveLoad(state), 8);
  });

  it("reconciles an accepted assignment with a newer snapshot", () => {
    let state = success(makeWorkerState(registration, snapshot()));
    state = success(reserve(state, requestA, 1_100));
    state = success(accept(state, requestA, 1_102));
    assert.equal(effectiveLoad(state), 8);

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

    assert.equal(state.assignments.size, 0);
    assert.equal(effectiveLoad(state), 8);
  });

  it("rejects stale snapshots and prevents over-reservation", () => {
    let state = success(
      makeWorkerState(registration, snapshot({ snapshotSequence: 2, inFlight: 9 }))
    );

    state = success(reserve(state, requestA, 1_100));

    const atCapacity = reserve(state, requestB, 1_101);
    assert(Result.isFailure(atCapacity));
    assert.equal(atCapacity.failure.reason, "AtCapacity");

    const stale = applySnapshot(state, snapshot({ snapshotSequence: 1, inFlight: 1 }));
    assert(Result.isFailure(stale));
    assert.equal(stale.failure.reason, "StaleSnapshot");
    assert.equal(effectiveLoad(state), 10);
  });
});
