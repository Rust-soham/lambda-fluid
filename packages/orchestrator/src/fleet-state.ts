import type { AttemptId, JobNack, RequestId, WorkerId } from "@lambda-fluid/protocol";
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import * as S from "effect/Schema";

import {
  admissionLimit,
  effectiveLoad,
  isEligible,
  release,
  reserve,
  suppress,
  type WorkerState,
} from "./worker-state.js";

// The fleet is the orchestrator's current spreadsheet of connected Lambda workers.
export interface FleetState {
  readonly workers: ReadonlyMap<WorkerId, WorkerState>;
}

export const emptyFleet = (): FleetState => ({ workers: new Map() });

export interface WorkerSelection {
  readonly workerId: WorkerId;
  readonly connectionGeneration: number;
}

// Tells the transport layer what must happen after fleet state has changed.
export type NackDirective = Data.TaggedEnum<{
  RetryAnotherWorker: { readonly rejectedWorkerId: WorkerId };
  DisconnectWorker: {
    readonly workerId: WorkerId;
    readonly connectionGeneration: number;
  };
}>;

export const NackDirective = Data.taggedEnum<NackDirective>();

// Traffic policy changes ranking only; health and capacity eligibility stay identical.
export type RoutingPolicy = Data.TaggedEnum<{
  Pack: {};
  Spread: {};
}>;

export const RoutingPolicy = Data.taggedEnum<RoutingPolicy>();

export const FleetTransitionFailure = S.Literals([
  "DuplicateRequest",
  "DuplicateWorker",
  "NoCapacity",
  "ReservationMissing",
  "StaleConnection",
  "UnknownWorker",
]);
export type FleetTransitionFailure = typeof FleetTransitionFailure.Type;

// oxfmt-ignore
export class FleetTransitionError
  extends S.TaggedErrorClass<FleetTransitionError>()(
    "Orchestrator.FleetTransitionError",
    {
      reason: FleetTransitionFailure,
    }
) {}

export interface FleetSelectionResult {
  readonly fleet: FleetState;
  readonly selection: WorkerSelection;
}

export interface FleetNackResult {
  readonly fleet: FleetState;
  readonly directive: NackDirective;
}

const failure = <A>(
  reason: FleetTransitionFailure
): Result.Result<A, FleetTransitionError> =>
  Result.fail(FleetTransitionError.make({ reason }));

const replaceWorker = (fleet: FleetState, worker: WorkerState): FleetState => {
  const workers = new Map(fleet.workers);
  workers.set(worker.workerId, worker);
  return { workers };
};

export const addWorker = (
  fleet: FleetState,
  worker: WorkerState
): Result.Result<FleetState, FleetTransitionError> => {
  if (fleet.workers.has(worker.workerId)) {
    return failure("DuplicateWorker");
  }
  return Result.succeed(replaceWorker(fleet, worker));
};

const utilization = (worker: WorkerState): number =>
  effectiveLoad(worker) / admissionLimit(worker);

// Pack minimizes positive headroom; Spread minimizes normalized utilization.
const rankedCandidates = (
  fleet: FleetState,
  policy: RoutingPolicy
): ReadonlyArray<WorkerState> =>
  [...fleet.workers.values()]
    .filter(
      (worker) => isEligible(worker) && effectiveLoad(worker) < admissionLimit(worker)
    )
    .sort((left, right) => {
      const comparison = RoutingPolicy.$match(policy, {
        Pack: () => {
          const leftHeadroom = admissionLimit(left) - effectiveLoad(left);
          const rightHeadroom = admissionLimit(right) - effectiveLoad(right);
          return leftHeadroom - rightHeadroom;
        },
        Spread: () => utilization(left) - utilization(right),
      });
      return comparison || left.workerId.localeCompare(right.workerId);
    });

// Selection and reservation are one pure transition; the TxRef wrapper commits it atomically.
export const selectAndReserve = (
  fleet: FleetState,
  requestId: RequestId,
  attemptId: AttemptId,
  reservedAtEpochMs: number,
  policy: RoutingPolicy
): Result.Result<FleetSelectionResult, FleetTransitionError> => {
  for (const worker of fleet.workers.values()) {
    if (worker.assignments.has(requestId)) {
      return failure("DuplicateRequest");
    }
  }

  const candidate = rankedCandidates(fleet, policy)[0];
  if (candidate === undefined) {
    return failure("NoCapacity");
  }

  const reserved = reserve(candidate, requestId, attemptId, reservedAtEpochMs);
  if (Result.isFailure(reserved)) {
    return failure("NoCapacity");
  }

  return Result.succeed({
    fleet: replaceWorker(fleet, reserved.success),
    selection: {
      workerId: candidate.workerId,
      connectionGeneration: candidate.connectionGeneration,
    },
  });
};

// A nack releases the request first, then changes the rejected worker's fleet eligibility.
export const applyNack = (
  fleet: FleetState,
  nack: JobNack
): Result.Result<FleetNackResult, FleetTransitionError> => {
  const worker = fleet.workers.get(nack.workerId);
  if (worker === undefined) {
    return failure("UnknownWorker");
  }
  if (worker.connectionGeneration !== nack.connectionGeneration) {
    return failure("StaleConnection");
  }

  const released = release(worker, nack.requestId, nack.attemptId);
  if (Result.isFailure(released)) {
    return failure("ReservationMissing");
  }

  if (nack.reason === "Internal") {
    const workers = new Map(fleet.workers);
    workers.delete(worker.workerId);
    return Result.succeed({
      fleet: { workers },
      directive: NackDirective.DisconnectWorker({
        workerId: worker.workerId,
        connectionGeneration: worker.connectionGeneration,
      }),
    });
  }

  const suppressed = suppress(released.success, nack.reason);
  return Result.succeed({
    fleet: replaceWorker(fleet, suppressed),
    directive: NackDirective.RetryAnotherWorker({
      rejectedWorkerId: worker.workerId,
    }),
  });
};
