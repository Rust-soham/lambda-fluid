import * as S from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProtocolVersion } from "./base.js";
import { AttemptId, RequestId, WorkerId } from "./identifiers.js";

export const WorkerDrainReason = S.Literals([
  "InvocationDeadline",
  "ScaleDown",
  "Shutdown",
]);
export type WorkerDrainReason = typeof WorkerDrainReason.Type;

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
    attemptId: AttemptId,
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    acceptedAtEpochMs: NonNegativeInt,
}) {}

// oxfmt-ignore
export class JobNack 
  extends S.TaggedClass<JobNack>()("JobNack", {
    requestId: RequestId,
    attemptId: AttemptId,
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    reason: JobNackReason,
    nackedAtEpochMs: NonNegativeInt,
}) {}

// oxfmt-ignore
export class WorkerDraining
  extends S.TaggedClass<WorkerDraining>()("WorkerDraining", {
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    startedAtEpochMs: NonNegativeInt,
    reason: WorkerDrainReason,
}) {}

export const WorkerFrame = S.Union([
  WorkerRegistration,
  WorkerHealthSnapshot,
  JobAccepted,
  JobNack,
  WorkerDraining,
]).pipe(S.toTaggedUnion("_tag"));

export type WorkerFrame = typeof WorkerFrame.Type;
