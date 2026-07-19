import * as S from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProtocolVersion } from "./base.js";
import { DeploymentId, RequestId } from "./identifiers.js";

export class SyntheticWorkload 
  extends S.Class<SyntheticWorkload>("SyntheticWorkload")({
    firstCpuMs: NonNegativeInt,
    ioDelayMs: NonNegativeInt,
    secondCpuMs: NonNegativeInt,
    responseChunks: PositiveInt,
    delayBetweenChunksMs: NonNegativeInt,
}) {}

export class JobRequest 
  extends S.TaggedClass<JobRequest>()("JobRequest", {
    protocolVersion: ProtocolVersion,
    requestId: RequestId,
    deploymentId: DeploymentId,
    sentAtEpochMs: NonNegativeInt,
    deadlineEpochMs: NonNegativeInt,
    workload: SyntheticWorkload,
}) {}
