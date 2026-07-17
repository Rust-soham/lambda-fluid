import { Schema as S } from "effect";

import { NonNegativeInt, PositiveInt, ProtocolVersion } from "./base.js";
import { DeploymentId, RequestId } from "./identifiers.js";

export const SyntheticWorkload = S.Struct({
  firstCpuMs: NonNegativeInt,
  ioDelayMs: NonNegativeInt,
  secondCpuMs: NonNegativeInt,
  responseChunks: PositiveInt,
  delayBetweenChunksMs: NonNegativeInt,
});

export interface SyntheticWorkload extends S.Schema.Type<typeof SyntheticWorkload> {}

export const JobRequest = S.TaggedStruct("JobRequest", {
  protocolVersion: ProtocolVersion,
  requestId: RequestId,
  deploymentId: DeploymentId,
  sentAtEpochMs: NonNegativeInt,
  deadlineEpochMs: NonNegativeInt,
  workload: SyntheticWorkload,
});

export interface JobRequest extends S.Schema.Type<typeof JobRequest> {}
