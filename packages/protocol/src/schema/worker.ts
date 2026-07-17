import { Schema as S } from "effect";

import { NonNegativeInt, PositiveInt, ProtocolVersion } from "./base.js";
import { DeploymentId, RequestId, WorkerId } from "./identifiers.js";

export const JobNackReason = S.Literals([
  "AtCapacity",
  "Draining",
  "HighCpu",
  "HighEventLoopLag",
  "HighMemory",
  "DeadlineTooClose",
  "Internal",
]);
export type JobNackReason = typeof JobNackReason.Type;

export const WorkerFrame = S.TaggedUnion({
  WorkerRegistration: {
    protocolVersion: ProtocolVersion,
    workerId: WorkerId,
    deploymentId: DeploymentId,
    maxConcurrency: PositiveInt,
    connectionGeneration: PositiveInt,
  },
  WorkerHealthSnapshot: {
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    snapshotSequence: NonNegativeInt,
    sampledAtEpochMs: NonNegativeInt,
    inFlight: NonNegativeInt,
    cpuUsedMicros: NonNegativeInt,
    sampleIntervalMicros: PositiveInt,
    rssBytes: NonNegativeInt,
    heapUsedBytes: NonNegativeInt,
    memoryLimitBytes: PositiveInt,
    eventLoopLagMicros: NonNegativeInt,
    draining: S.Boolean,
  },
  JobAccepted: {
    requestId: RequestId,
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    acceptedAtEpochMs: NonNegativeInt,
  },
  JobNack: {
    requestId: RequestId,
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    reason: JobNackReason,
    nackedAtEpochMs: NonNegativeInt,
  },
});

export type WorkerFrame = typeof WorkerFrame.Type;

export const WorkerRegistration = WorkerFrame.cases.WorkerRegistration;
export type WorkerRegistration = typeof WorkerRegistration.Type;

export const WorkerHealthSnapshot = WorkerFrame.cases.WorkerHealthSnapshot;
export type WorkerHealthSnapshot = typeof WorkerHealthSnapshot.Type;

export const JobAccepted = WorkerFrame.cases.JobAccepted;
export type JobAccepted = typeof JobAccepted.Type;

export const JobNack = WorkerFrame.cases.JobNack;
export type JobNack = typeof JobNack.Type;
