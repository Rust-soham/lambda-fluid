import type { AttemptId, JobRequest, RequestId } from "@lambda-fluid/protocol";
import * as Data from "effect/Data";

export type WorkerAdmission = Data.TaggedEnum<{
  Accepting: { readonly limit: number };
  Draining: {};
}>;

export const WorkerAdmission = Data.taggedEnum<WorkerAdmission>();

export interface WorkerState {
  readonly admission: WorkerAdmission;
  readonly activeAttempts: ReadonlyMap<RequestId, AttemptId>;
  readonly inFlightHighWater: number;
}

export type AdmissionDecision = Data.TaggedEnum<{
  Accepted: {};
  Rejected: { readonly reason: "AtCapacity" | "Draining" };
}>;

export const AdmissionDecision = Data.taggedEnum<AdmissionDecision>();

/** Claims a slot when the worker can execute the attempt immediately. */
export const admit = (
  state: WorkerState,
  request: JobRequest
): [AdmissionDecision, WorkerState] => {
  if (WorkerAdmission.$is("Draining")(state.admission)) {
    return [AdmissionDecision.Rejected({ reason: "Draining" }), state];
  }
  if (
    state.activeAttempts.has(request.requestId) ||
    state.activeAttempts.size >= state.admission.limit
  ) {
    return [AdmissionDecision.Rejected({ reason: "AtCapacity" }), state];
  }

  const activeAttempts = new Map(state.activeAttempts);
  activeAttempts.set(request.requestId, request.attemptId);
  return [
    AdmissionDecision.Accepted(),
    {
      ...state,
      activeAttempts,
      inFlightHighWater: Math.max(state.inFlightHighWater, activeAttempts.size),
    },
  ];
};

/** Removes only the attempt that currently owns the logical request slot. */
export const finish = (
  state: WorkerState,
  requestId: RequestId,
  attemptId: AttemptId
): WorkerState => {
  if (state.activeAttempts.get(requestId) !== attemptId) return state;
  const activeAttempts = new Map(state.activeAttempts);
  activeAttempts.delete(requestId);
  return { ...state, activeAttempts };
};
