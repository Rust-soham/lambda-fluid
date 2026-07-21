import type {
  JobNackReason,
  AttemptId,
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
  Reserved: {
    readonly attemptId: AttemptId;
    readonly reservedAtEpochMs: number;
  };
  Accepted: {
    readonly attemptId: AttemptId;
    readonly acceptedAtEpochMs: number;
  };
}>;

export const Assignment = Data.taggedEnum<Assignment>();

// Keeps the worker's learned limit together with whether routing may use it.
export type AdmissionControl = Data.TaggedEnum<{
  Eligible: { readonly limit: number };
  Suppressed: {
    readonly limit: number;
    readonly reason: Exclude<JobNackReason, "Internal">;
    readonly suppressedAtSnapshotSequence: number;
  };
}>;

export const AdmissionControl = Data.taggedEnum<AdmissionControl>();

// Combines the worker's last report with newer orchestrator-owned reservations.
export interface WorkerState {
  readonly workerId: WorkerId;
  readonly connectionGeneration: number;
  readonly maxConcurrency: number;
  readonly admission: AdmissionControl;
  readonly snapshot: WorkerHealthSnapshot;
  readonly assignments: ReadonlyMap<RequestId, Assignment>;
  /** Highest load observed from snapshots plus orchestrator-owned reservations. */
  readonly peakEffectiveLoad: number;
}

// Defines when runtime measurements should reduce a worker's admission limit.
export interface HealthPolicy {
  readonly cpuPressureRatio: number;
  readonly memoryPressureRatio: number;
  readonly eventLoopLagMicros: number;
}

export interface WorkerStateOptions {
  /** Explicit seed used by controlled benchmarks; production defaults to one. */
  readonly initialAdmissionLimit?: number;
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
  "Suppressed",
  "StaleConnection",
  "StaleAttempt",
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
  snapshot: WorkerHealthSnapshot,
  options: WorkerStateOptions = {}
): TransitionResult => {
  if (registration.workerId !== snapshot.workerId) {
    return failure("WorkerMismatch");
  }
  if (registration.connectionGeneration !== snapshot.connectionGeneration) {
    return failure("StaleConnection");
  }

  const initialAdmissionLimit = Math.min(
    registration.maxConcurrency,
    Math.max(1, options.initialAdmissionLimit ?? snapshot.inFlight + 1)
  );

  return Result.succeed({
    workerId: registration.workerId,
    connectionGeneration: registration.connectionGeneration,
    maxConcurrency: registration.maxConcurrency,
    admission:
      snapshot.admissionState === "Draining"
        ? AdmissionControl.Suppressed({
            limit: initialAdmissionLimit,
            reason: "Draining",
            suppressedAtSnapshotSequence: snapshot.snapshotSequence,
          })
        : AdmissionControl.Eligible({
            limit: initialAdmissionLimit,
          }),
    snapshot,
    assignments: new Map(),
    peakEffectiveLoad: snapshot.inFlight,
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

// Exposes the learned limit without allowing callers to ignore eligibility.
export const admissionLimit = (state: WorkerState): number => state.admission.limit;

export const isEligible = (state: WorkerState): boolean =>
  AdmissionControl.$is("Eligible")(state.admission);

// Claims one admission slot before the job is written to the worker tunnel.
export const reserve = (
  state: WorkerState,
  requestId: RequestId,
  attemptId: AttemptId,
  reservedAtEpochMs: number
): TransitionResult => {
  if (AdmissionControl.$is("Suppressed")(state.admission)) {
    return failure(state.admission.reason === "Draining" ? "Draining" : "Suppressed");
  }
  if (state.assignments.has(requestId)) {
    return failure("DuplicateRequest");
  }
  if (effectiveLoad(state) >= state.admission.limit) {
    return failure("AtCapacity");
  }

  const assignments = new Map(state.assignments);
  assignments.set(requestId, Assignment.Reserved({ attemptId, reservedAtEpochMs }));
  return Result.succeed({
    ...state,
    assignments,
    peakEffectiveLoad: Math.max(state.peakEffectiveLoad, effectiveLoad(state) + 1),
  });
};

// Makes fresher worker evidence authoritative over the last routable snapshot.
export const suppress = (
  state: WorkerState,
  reason: Exclude<JobNackReason, "Internal">
): WorkerState => {
  // Several requests may nack concurrently from the same reported state.
  // One snapshot is allowed to reduce the learned limit only once.
  if (
    AdmissionControl.$is("Suppressed")(state.admission) &&
    state.admission.suppressedAtSnapshotSequence === state.snapshot.snapshotSequence
  ) {
    return state;
  }

  return {
    ...state,
    admission: AdmissionControl.Suppressed({
      limit: Math.max(1, Math.floor(state.admission.limit / 2)),
      reason,
      suppressedAtSnapshotSequence: state.snapshot.snapshotSequence,
    }),
  };
};

// Replaces a reservation with the worker's acknowledgement of the job.
export const accept = (
  state: WorkerState,
  requestId: RequestId,
  attemptId: AttemptId,
  acceptedAtEpochMs: number
): TransitionResult => {
  const assignment = state.assignments.get(requestId);
  if (assignment === undefined || !Assignment.$is("Reserved")(assignment)) {
    return failure("ReservationMissing");
  }
  if (assignment.attemptId !== attemptId) {
    return failure("StaleAttempt");
  }

  const assignments = new Map(state.assignments);
  assignments.set(requestId, Assignment.Accepted({ attemptId, acceptedAtEpochMs }));
  return Result.succeed({ ...state, assignments });
};

// Removes a reservation or accepted assignment after nack, completion, or cancellation.
export const release = (
  state: WorkerState,
  requestId: RequestId,
  attemptId: AttemptId
): TransitionResult => {
  const assignment = state.assignments.get(requestId);
  if (assignment === undefined) {
    return failure("ReservationMissing");
  }
  if (assignment.attemptId !== attemptId) {
    return failure("StaleAttempt");
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
  const pressureReason:
    | Exclude<JobNackReason, "Internal" | "AtCapacity" | "Draining">
    | undefined =
    cpuPressure >= policy.cpuPressureRatio
      ? "HighCpu"
      : memoryPressure >= policy.memoryPressureRatio
        ? "HighMemory"
        : snapshot.eventLoopLagMicros >= policy.eventLoopLagMicros
          ? "HighEventLoopLag"
          : undefined;

  const currentLimit = state.admission.limit;
  let admission: AdmissionControl;

  // Draining is terminal for this invocation, even if a contradictory snapshot arrives later.
  if (
    AdmissionControl.$is("Suppressed")(state.admission) &&
    state.admission.reason === "Draining"
  ) {
    admission = state.admission;
  } else if (snapshot.admissionState === "Draining") {
    admission = AdmissionControl.Suppressed({
      limit: currentLimit,
      reason: "Draining",
      suppressedAtSnapshotSequence: snapshot.snapshotSequence,
    });
  } else if (pressureReason !== undefined) {
    admission = AdmissionControl.Suppressed({
      limit: Math.max(1, Math.floor(currentLimit / 2)),
      reason: pressureReason,
      suppressedAtSnapshotSequence: snapshot.snapshotSequence,
    });
  } else if (AdmissionControl.$is("Suppressed")(state.admission)) {
    // One newer healthy snapshot restores routing but preserves the reduced limit.
    admission = AdmissionControl.Eligible({ limit: currentLimit });
  } else {
    // Healthy saturation is evidence that one additional slot may be explored safely.
    admission = AdmissionControl.Eligible({
      limit:
        snapshot.inFlightHighWater >= currentLimit
          ? Math.min(state.maxConcurrency, currentLimit + 1)
          : currentLimit,
    });
  }

  return Result.succeed({ ...state, admission, snapshot, assignments });
};
