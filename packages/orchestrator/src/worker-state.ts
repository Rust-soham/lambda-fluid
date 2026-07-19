import type {
  DeploymentId,
  RequestId,
  WorkerHealthSnapshot,
  WorkerId,
  WorkerRegistration,
} from "@lambda-fluid/protocol";
import { Data, Result, Schema as S } from "effect";

export type Assignment = Data.TaggedEnum<{
  Reserved: { readonly reservedAtEpochMs: number };
  Accepted: { readonly acceptedAtEpochMs: number };
}>;

export const Assignment = Data.taggedEnum<Assignment>();

export interface WorkerState {
  readonly workerId: WorkerId;
  readonly deploymentId: DeploymentId;
  readonly connectionGeneration: number;
  readonly maxConcurrency: number;
  readonly snapshot: WorkerHealthSnapshot;
  readonly assignments: ReadonlyMap<RequestId, Assignment>;
}

export const WorkerTransitionFailure = S.Literals([
  "AtCapacity",
  "Draining",
  "DuplicateRequest",
  "ReservationMissing",
  "StaleConnection",
  "StaleSnapshot",
  "WorkerMismatch",
]);
export type WorkerTransitionFailure = typeof WorkerTransitionFailure.Type;

export class WorkerTransitionError 
  extends S.TaggedErrorClass<WorkerTransitionError>()(
    "Orchestrator.WorkerTransitionError",
    { 
      reason: WorkerTransitionFailure 
    }
) {}

export type TransitionResult = Result.Result<WorkerState, WorkerTransitionError>;



const failure = (reason: WorkerTransitionFailure): TransitionResult =>
  Result.fail(WorkerTransitionError.make({ reason }));



export const makeWorkerState = (
  registration: WorkerRegistration,
  snapshot: WorkerHealthSnapshot
): TransitionResult => {
  if (registration.workerId !== snapshot.workerId) {
    return failure("WorkerMismatch");
  }
  if (registration.connectionGeneration !== snapshot.connectionGeneration) {
    return failure("StaleConnection");
  }

  return Result.succeed({
    workerId: registration.workerId,
    deploymentId: registration.deploymentId,
    connectionGeneration: registration.connectionGeneration,
    maxConcurrency: registration.maxConcurrency,
    snapshot,
    assignments: new Map(),
  });
};


const overlaysSnapshot = (assignment: Assignment, sampledAtEpochMs: number): boolean =>
  Assignment.$match(assignment, {
    Reserved: () => true,
    Accepted: ({ acceptedAtEpochMs }) => acceptedAtEpochMs > sampledAtEpochMs,
  });

export const effectiveLoad = (state: WorkerState): number => {
  let overlay = 0;

  for (const assignment of state.assignments.values()) {
    if (overlaysSnapshot(assignment, state.snapshot.sampledAtEpochMs)) {
      overlay += 1;
    }
  }

  return state.snapshot.inFlight + overlay;
};


export const reserve = (
  state: WorkerState,
  requestId: RequestId,
  reservedAtEpochMs: number
): TransitionResult => {
  if (state.snapshot.draining) {
    return failure("Draining");
  }
  if (state.assignments.has(requestId)) {
    return failure("DuplicateRequest");
  }
  if (effectiveLoad(state) >= state.maxConcurrency) {
    return failure("AtCapacity");
  }

  const assignments = new Map(state.assignments);
  assignments.set(requestId, Assignment.Reserved({ reservedAtEpochMs }));
  return Result.succeed({ ...state, assignments });
};


export const accept = (
  state: WorkerState,
  requestId: RequestId,
  acceptedAtEpochMs: number
): TransitionResult => {
  const assignment = state.assignments.get(requestId);
  if (assignment === undefined || !Assignment.$is("Reserved")(assignment)) {
    return failure("ReservationMissing");
  }

  const assignments = new Map(state.assignments);
  assignments.set(requestId, Assignment.Accepted({ acceptedAtEpochMs }));
  return Result.succeed({ ...state, assignments });
};


export const release = (state: WorkerState, requestId: RequestId): TransitionResult => {
  if (!state.assignments.has(requestId)) {
    return failure("ReservationMissing");
  }

  const assignments = new Map(state.assignments);
  assignments.delete(requestId);
  return Result.succeed({ ...state, assignments });
};


export const applySnapshot = (
  state: WorkerState,
  snapshot: WorkerHealthSnapshot
): TransitionResult => {
  if (snapshot.workerId !== state.workerId) {
    return failure("WorkerMismatch");
  }
  if (snapshot.connectionGeneration !== state.connectionGeneration) {
    return failure("StaleConnection");
  }
  if (snapshot.snapshotSequence <= state.snapshot.snapshotSequence) {
    return failure("StaleSnapshot");
  }

  const assignments = new Map(state.assignments);
  for (const [requestId, assignment] of assignments) {
    if (
      Assignment.$is("Accepted")(assignment) &&
      assignment.acceptedAtEpochMs <= snapshot.sampledAtEpochMs
    ) {
      assignments.delete(requestId);
    }
  }

  return Result.succeed({ ...state, snapshot, assignments });
};
