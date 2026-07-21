import type { AttemptId, JobNack, RequestId } from "@lambda-fluid/protocol";
import * as Effect from "effect/Effect";
import * as TxRef from "effect/TxRef";

import {
  applyNack,
  emptyFleet,
  selectAndReserve,
  type FleetNackResult,
  type FleetState,
  type FleetTransitionError,
  type RoutingPolicy,
  type WorkerSelection,
} from "./fleet-state.js";

// Owns the single transactional cell used by every concurrent routing fiber.
export interface FleetRegistry {
  readonly snapshot: Effect.Effect<FleetState>;
  readonly selectAndReserve: (
    requestId: RequestId,
    attemptId: AttemptId,
    reservedAtEpochMs: number,
    policy: RoutingPolicy
  ) => Effect.Effect<WorkerSelection, FleetTransitionError>;
  readonly applyNack: (
    nack: JobNack
  ) => Effect.Effect<FleetNackResult["directive"], FleetTransitionError>;
}

export const makeFleetRegistry = (
  initial: FleetState = emptyFleet()
): Effect.Effect<FleetRegistry> =>
  Effect.gen(function* () {
    const state = yield* TxRef.make(initial);

    return {
      snapshot: Effect.tx(TxRef.get(state)),
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
    };
  });
