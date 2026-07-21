import type {
  AttemptId,
  JobAccepted,
  JobNack,
  RequestId,
  WorkerHealthSnapshot,
  WorkerId,
} from "@lambda-fluid/protocol";
import * as Effect from "effect/Effect";
import * as TxRef from "effect/TxRef";

import {
  applyNack,
  addWorker,
  emptyFleet,
  FleetTransitionError,
  selectAndReserve,
  type FleetNackResult,
  type FleetState,
  type RoutingPolicy,
  type WorkerSelection,
} from "./fleet-state.js";
import {
  accept,
  applySnapshot,
  release,
  type WorkerState,
  type WorkerTransitionError,
} from "./worker-state.js";

export type FleetRegistryError = FleetTransitionError | WorkerTransitionError;

// Owns the single transactional cell used by every concurrent routing fiber.
export interface FleetRegistry {
  readonly snapshot: Effect.Effect<FleetState>;
  readonly awaitWorker: (workerId: WorkerId) => Effect.Effect<void>;
  readonly addWorker: (
    worker: WorkerState
  ) => Effect.Effect<void, FleetTransitionError>;
  readonly removeWorker: (
    workerId: WorkerId,
    connectionGeneration: number
  ) => Effect.Effect<void>;
  readonly selectAndReserve: (
    requestId: RequestId,
    attemptId: AttemptId,
    reservedAtEpochMs: number,
    policy: RoutingPolicy
  ) => Effect.Effect<WorkerSelection, FleetTransitionError>;
  readonly applyNack: (
    nack: JobNack
  ) => Effect.Effect<FleetNackResult["directive"], FleetTransitionError>;
  readonly accept: (frame: JobAccepted) => Effect.Effect<void, FleetRegistryError>;
  readonly release: (
    workerId: WorkerId,
    connectionGeneration: number,
    requestId: RequestId,
    attemptId: AttemptId
  ) => Effect.Effect<void, FleetRegistryError>;
  readonly applySnapshot: (
    snapshot: WorkerHealthSnapshot
  ) => Effect.Effect<void, FleetRegistryError>;
}

export const makeFleetRegistry = (
  initial: FleetState = emptyFleet()
): Effect.Effect<FleetRegistry> =>
  Effect.gen(function* () {
    const state = yield* TxRef.make(initial);

    return {
      snapshot: Effect.tx(TxRef.get(state)),
      awaitWorker: (workerId) =>
        Effect.tx(
          Effect.gen(function* () {
            const current = yield* TxRef.get(state);
            if (!current.workers.has(workerId)) {
              return yield* Effect.txRetry;
            }
          })
        ),
      addWorker: (worker) =>
        Effect.tx(
          Effect.gen(function* () {
            const current = yield* TxRef.get(state);
            const next = yield* Effect.fromResult(addWorker(current, worker));
            yield* TxRef.set(state, next);
          })
        ),
      removeWorker: (workerId, connectionGeneration) =>
        Effect.tx(
          TxRef.update(state, (current) => {
            const worker = current.workers.get(workerId);
            if (
              worker === undefined ||
              worker.connectionGeneration !== connectionGeneration
            ) {
              return current;
            }
            const workers = new Map(current.workers);
            workers.delete(workerId);
            return { workers };
          })
        ),
      selectAndReserve: (requestId, attemptId, reservedAtEpochMs, policy) =>
        Effect.tx(
          Effect.gen(function* () {
            const current = yield* TxRef.get(state);
            const transition = yield* Effect.fromResult(
              selectAndReserve(current, requestId, attemptId, reservedAtEpochMs, policy)
            );
            yield* TxRef.set(state, transition.fleet);
            return transition.selection;
          })
        ),
      applyNack: (nack) =>
        Effect.tx(
          Effect.gen(function* () {
            const current = yield* TxRef.get(state);
            const transition = yield* Effect.fromResult(applyNack(current, nack));
            yield* TxRef.set(state, transition.fleet);
            return transition.directive;
          })
        ),
      accept: (frame) =>
        Effect.tx(
          Effect.gen(function* () {
            const current = yield* TxRef.get(state);
            const worker = current.workers.get(frame.workerId);
            if (worker === undefined) {
              return yield* Effect.fail(
                FleetTransitionError.make({ reason: "UnknownWorker" })
              );
            }
            if (worker.connectionGeneration !== frame.connectionGeneration) {
              return yield* Effect.fail(
                FleetTransitionError.make({ reason: "StaleConnection" })
              );
            }
            const nextWorker = yield* Effect.fromResult(
              accept(worker, frame.requestId, frame.attemptId, frame.acceptedAtEpochMs)
            );
            const workers = new Map(current.workers);
            workers.set(frame.workerId, nextWorker);
            yield* TxRef.set(state, { workers });
          })
        ),
      release: (workerId, connectionGeneration, requestId, attemptId) =>
        Effect.tx(
          Effect.gen(function* () {
            const current = yield* TxRef.get(state);
            const worker = current.workers.get(workerId);
            if (worker === undefined) {
              return yield* Effect.fail(
                FleetTransitionError.make({ reason: "UnknownWorker" })
              );
            }
            if (worker.connectionGeneration !== connectionGeneration) {
              return yield* Effect.fail(
                FleetTransitionError.make({ reason: "StaleConnection" })
              );
            }
            const nextWorker = yield* Effect.fromResult(
              release(worker, requestId, attemptId)
            );
            const workers = new Map(current.workers);
            workers.set(workerId, nextWorker);
            yield* TxRef.set(state, { workers });
          })
        ),
      applySnapshot: (snapshot) =>
        Effect.tx(
          Effect.gen(function* () {
            const current = yield* TxRef.get(state);
            const worker = current.workers.get(snapshot.workerId);
            if (worker === undefined) {
              return yield* Effect.fail(
                FleetTransitionError.make({ reason: "UnknownWorker" })
              );
            }
            const nextWorker = yield* Effect.fromResult(
              applySnapshot(worker, snapshot)
            );
            const workers = new Map(current.workers);
            workers.set(snapshot.workerId, nextWorker);
            yield* TxRef.set(state, { workers });
          })
        ),
    };
  });
