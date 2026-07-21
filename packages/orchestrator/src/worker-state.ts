import type {
  RequestId,
  WorkerHealthSnapshot,
  WorkerId,
  WorkerRegistration,
} from "@lambda-fluid/protocol";
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import * as S from "effect/Schema";

// Tracks work the orchestrator has sent since the worker's last health snapshot.
export type Assignment = Data.TaggedEnum<{
  Reserved: { readonly reservedAtEpochMs: number };
  Accepted: { readonly acceptedAtEpochMs: number };
}>;

export const Assignment = Data.taggedEnum<Assignment>();

// Combines the worker's last report with newer orchestrator-owned reservations.
export interface WorkerState {
  readonly workerId: WorkerId;
  readonly connectionGeneration: number;
  readonly maxConcurrency: number;
  readonly admissionLimit: number;
  readonly snapshot: WorkerHealthSnapshot;
  readonly assignments: ReadonlyMap<RequestId, Assignment>;
}

// Defines when runtime measurements should reduce a worker's admission limit.
export interface HealthPolicy {
  readonly cpuPressureRatio: number;
  readonly memoryPressureRatio: number;
  readonly eventLoopLagMicros: number;
}

export const defaultHealthPolicy: HealthPolicy = {
  cpuPressureRatio: 0.8,
  memoryPressureRatio: 0.8,
  eventLoopLagMicros: 50_000,
};

// Describes expected failures when applying a worker-state transition.
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

// oxfmt-ignore
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

// Creates state only when registration and the initial snapshot identify the same worker connection.
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
    connectionGeneration: registration.connectionGeneration,
    maxConcurrency: registration.maxConcurrency,
    admissionLimit: Math.min(
      registration.maxConcurrency,
      Math.max(1, snapshot.inFlight + 1)
    ),
    snapshot,
    assignments: new Map(),
  });
};

// Decides whether an assignment happened too recently to be included in the last snapshot.
const overlaysSnapshot = (assignment: Assignment, sampledAtEpochMs: number): boolean =>
  Assignment.$match(assignment, {
    Reserved: () => true,
    Accepted: ({ acceptedAtEpochMs }) => acceptedAtEpochMs > sampledAtEpochMs,
  });

// Adds newer reservations and acceptances to the worker-reported in-flight count.
export const effectiveLoad = (state: WorkerState): number => {
  let overlay = 0;

  for (const assignment of state.assignments.values()) {
    if (overlaysSnapshot(assignment, state.snapshot.sampledAtEpochMs)) {
      overlay += 1;
    }
  }

  return state.snapshot.inFlight + overlay;
};

// Claims one admission slot before the job is written to the worker tunnel.
export const reserve = (
  state: WorkerState,
  requestId: RequestId,
  reservedAtEpochMs: number
): TransitionResult => {
  if (state.snapshot.admissionState === "Draining") {
    return failure("Draining");
  }
  if (state.assignments.has(requestId)) {
    return failure("DuplicateRequest");
  }
  if (effectiveLoad(state) >= state.admissionLimit) {
    return failure("AtCapacity");
  }

  const assignments = new Map(state.assignments);
  assignments.set(requestId, Assignment.Reserved({ reservedAtEpochMs }));
  return Result.succeed({ ...state, assignments });
};

// Replaces a reservation with the worker's acknowledgement of the job.
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

// Removes a reservation or accepted assignment after nack, completion, or cancellation.
export const release = (state: WorkerState, requestId: RequestId): TransitionResult => {
  if (!state.assignments.has(requestId)) {
    return failure("ReservationMissing");
  }

  const assignments = new Map(state.assignments);
  assignments.delete(requestId);
  return Result.succeed({ ...state, assignments });
};

// Reconciles newer worker evidence and adapts how much concurrency may be admitted.
export const applySnapshot = (
  state: WorkerState,
  snapshot: WorkerHealthSnapshot,
  policy: HealthPolicy = defaultHealthPolicy
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
  // A snapshot sampled after acceptance has incorporated that job into its in-flight count.
  for (const [requestId, assignment] of assignments) {
    if (
      Assignment.$is("Accepted")(assignment) &&
      assignment.acceptedAtEpochMs <= snapshot.sampledAtEpochMs
    ) {
      assignments.delete(requestId);
    }
  }

  const cpuPressure = snapshot.cpuUsedMicros / snapshot.sampleIntervalMicros;
  const memoryPressure = snapshot.rssBytes / snapshot.memoryLimitBytes;
  const isUnderPressure =
    cpuPressure >= policy.cpuPressureRatio ||
    memoryPressure >= policy.memoryPressureRatio ||
    snapshot.eventLoopLagMicros >= policy.eventLoopLagMicros;

  // Back off sharply under pressure; otherwise explore one extra slot after proven saturation.
  const admissionLimit = isUnderPressure
    ? Math.max(1, Math.floor(state.admissionLimit / 2))
    : snapshot.inFlightHighWater >= state.admissionLimit
      ? Math.min(state.maxConcurrency, state.admissionLimit + 1)
      : state.admissionLimit;

  return Result.succeed({ ...state, admissionLimit, snapshot, assignments });
};
