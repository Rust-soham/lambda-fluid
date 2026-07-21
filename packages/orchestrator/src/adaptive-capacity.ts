import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Success } from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as TxRef from "effect/TxRef";

import { RoutingPolicy } from "./fleet-state.js";

export interface AdaptiveCapacityOptions {
  readonly slotsPerWorker: number;
  readonly maxWorkers: number;
  readonly spreadAtConcurrency: number;
  readonly packBelowConcurrency: number;
  readonly launch: (workerNumber: number) => Effect.Effect<void, never, Scope.Scope>;
}

export interface RoutingLease {
  readonly policy: RoutingPolicy;
  readonly release: Effect.Effect<void>;
}

export interface CapacitySnapshot {
  readonly activeRequests: number;
  readonly readyWorkers: number;
  readonly startingWorkers: number;
  readonly peakWorkers: number;
  readonly mode: "Pack" | "Spread";
}

interface CapacityState extends CapacitySnapshot {}

type CapacityDecision = Data.TaggedEnum<{
  Ready: {};
  Launch: { readonly workerNumbers: ReadonlyArray<number> };
}>;

const CapacityDecision = Data.taggedEnum<CapacityDecision>();

/** Coordinates traffic mode and worker launch claims in one transactional cell. */
export const makeAdaptiveCapacity = (options: AdaptiveCapacityOptions) =>
  Effect.gen(function* () {
    const state = yield* TxRef.make<CapacityState>({
      activeRequests: 0,
      readyWorkers: 0,
      startingWorkers: 0,
      peakWorkers: 0,
      mode: "Pack",
    });

    const ensureWorkers = Effect.fn("AdaptiveCapacity.ensureWorkers")(function* (
      desiredWorkers: number
    ) {
      const decision = yield* Effect.tx(
        Effect.gen(function* () {
          const current = yield* TxRef.get(state);
          if (current.readyWorkers >= desiredWorkers) {
            return CapacityDecision.Ready();
          }
          if (current.readyWorkers + current.startingWorkers >= desiredWorkers) {
            return yield* Effect.txRetry;
          }

          const launchCount =
            desiredWorkers - current.readyWorkers - current.startingWorkers;
          const firstWorkerNumber = current.readyWorkers + current.startingWorkers + 1;
          const workerNumbers = Array.from(
            { length: launchCount },
            (_, index) => firstWorkerNumber + index
          );
          yield* TxRef.set(state, {
            ...current,
            startingWorkers: current.startingWorkers + launchCount,
          });
          return CapacityDecision.Launch({ workerNumbers });
        })
      );

      if (CapacityDecision.$is("Ready")(decision)) return;

      yield* Effect.forEach(decision.workerNumbers, options.launch, {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Effect.tx(
        TxRef.update(state, (current) => {
          const readyWorkers = current.readyWorkers + decision.workerNumbers.length;
          return {
            ...current,
            readyWorkers,
            startingWorkers: current.startingWorkers - decision.workerNumbers.length,
            peakWorkers: Math.max(current.peakWorkers, readyWorkers),
          };
        })
      );
    });

    const acquire = Effect.fn("AdaptiveCapacity.acquire")(function* () {
      const admission = yield* Effect.tx(
        Effect.gen(function* () {
          const current = yield* TxRef.get(state);
          const activeRequests = current.activeRequests + 1;
          const mode =
            current.mode === "Pack" && activeRequests >= options.spreadAtConcurrency
              ? "Spread"
              : current.mode;
          const desiredWorkers = Math.min(
            options.maxWorkers,
            Math.max(1, Math.ceil(activeRequests / options.slotsPerWorker))
          );
          yield* TxRef.set(state, { ...current, activeRequests, mode });
          return { desiredWorkers, mode };
        })
      );

      yield* ensureWorkers(admission.desiredWorkers);

      const release = Effect.tx(
        TxRef.update(state, (current) => {
          const activeRequests = Math.max(0, current.activeRequests - 1);
          const mode =
            current.mode === "Spread" && activeRequests <= options.packBelowConcurrency
              ? "Pack"
              : current.mode;
          return { ...current, activeRequests, mode };
        })
      );

      return {
        policy:
          admission.mode === "Spread" ? RoutingPolicy.Spread() : RoutingPolicy.Pack(),
        release,
      } satisfies RoutingLease;
    });

    return {
      acquire,
      snapshot: Effect.tx(TxRef.get(state)),
    };
  });

export interface AdaptiveCapacity extends Success<
  ReturnType<typeof makeAdaptiveCapacity>
> {}
