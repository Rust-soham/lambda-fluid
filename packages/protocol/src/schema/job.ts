import * as S from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProtocolVersion } from "./base.js";
import { AttemptId, RequestId, WorkerId } from "./identifiers.js";

export const RetrySafety = S.Literals(["RetrySafe", "NonRetryable"]);
export type RetrySafety = typeof RetrySafety.Type;

export const DrainReason = S.Literals(["ScaleDown", "Shutdown"]);
export type DrainReason = typeof DrainReason.Type;

// oxfmt-ignore
export class SyntheticWorkload 
  extends S.Class<SyntheticWorkload>("SyntheticWorkload")({
    firstCpuMs: NonNegativeInt,
    ioDelayMs: NonNegativeInt,
    secondCpuMs: NonNegativeInt,
    responseChunks: PositiveInt,
    delayBetweenChunksMs: NonNegativeInt,
}) {}

// oxfmt-ignore
export class JobRequest 
  extends S.TaggedClass<JobRequest>()("JobRequest", {
    protocolVersion: ProtocolVersion,
    requestId: RequestId,
    attemptId: AttemptId,
    sentAtEpochMs: NonNegativeInt,
    deadlineEpochMs: NonNegativeInt,
    retrySafety: RetrySafety,
    workload: SyntheticWorkload,
}) {}

// oxfmt-ignore
export class RegistrationAccepted
  extends S.TaggedClass<RegistrationAccepted>()("RegistrationAccepted", {
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    acceptedAtEpochMs: NonNegativeInt,
}) {}

// oxfmt-ignore
export class CancelJob
  extends S.TaggedClass<CancelJob>()("CancelJob", {
    requestId: RequestId,
    attemptId: AttemptId,
    cancelledAtEpochMs: NonNegativeInt,
}) {}

// oxfmt-ignore
export class BeginDrain
  extends S.TaggedClass<BeginDrain>()("BeginDrain", {
    requestedAtEpochMs: NonNegativeInt,
    reason: DrainReason,
}) {}
