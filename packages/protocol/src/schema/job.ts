import * as S from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProtocolVersion } from "./base.js";
import { RequestId } from "./identifiers.js";

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
    sentAtEpochMs: NonNegativeInt,
    deadlineEpochMs: NonNegativeInt,
    workload: SyntheticWorkload,
}) {}
