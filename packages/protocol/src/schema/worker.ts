import * as S from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProtocolVersion } from "./base.js";
import { RequestId, WorkerId } from "./identifiers.js";

export const JobNackReason = S.Literals([
  "AtCapacity",
  "Draining",
  "HighCpu",
  "HighEventLoopLag",
  "HighMemory",
  "Internal",
]);
export type JobNackReason = typeof JobNackReason.Type;

export const WorkerAdmissionState = S.Literals(["Accepting", "Draining"]);
export type WorkerAdmissionState = typeof WorkerAdmissionState.Type;

// oxfmt-ignore
export class WorkerRegistration 
  extends S.TaggedClass<WorkerRegistration>()(
    "WorkerRegistration",
    {
      protocolVersion: ProtocolVersion,
      workerId: WorkerId,
      maxConcurrency: PositiveInt,
      connectionGeneration: PositiveInt,
      invocationDeadlineEpochMs: NonNegativeInt,
    }
) {}

// oxfmt-ignore
export class WorkerHealthSnapshot 
  extends S.TaggedClass<WorkerHealthSnapshot>()(
    "WorkerHealthSnapshot",
    {
      workerId: WorkerId,
      connectionGeneration: PositiveInt,
      snapshotSequence: NonNegativeInt,
      sampledAtEpochMs: NonNegativeInt,
      inFlight: NonNegativeInt,
      inFlightHighWater: NonNegativeInt,
      cpuUsedMicros: NonNegativeInt,
      sampleIntervalMicros: PositiveInt,
      rssBytes: NonNegativeInt,
      heapUsedBytes: NonNegativeInt,
      memoryLimitBytes: PositiveInt,
      eventLoopLagMicros: NonNegativeInt,
      admissionState: WorkerAdmissionState,
    }
) {}

// oxfmt-ignore
export class JobAccepted 
  extends S.TaggedClass<JobAccepted>()("JobAccepted", {
    requestId: RequestId,
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    acceptedAtEpochMs: NonNegativeInt,
}) {}

// oxfmt-ignore
export class JobNack 
  extends S.TaggedClass<JobNack>()("JobNack", {
    requestId: RequestId,
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    reason: JobNackReason,
    nackedAtEpochMs: NonNegativeInt,
}) {}

export const WorkerFrame = S.Union([
  WorkerRegistration,
  WorkerHealthSnapshot,
  JobAccepted,
  JobNack,
]).pipe(S.toTaggedUnion("_tag"));

export type WorkerFrame = typeof WorkerFrame.Type;
