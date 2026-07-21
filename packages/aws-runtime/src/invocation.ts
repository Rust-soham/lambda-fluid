import { PositiveInt, WorkerId } from "@lambda-fluid/protocol";
import * as S from "effect/Schema";

export const WorkerInvocation = S.TaggedUnion({
  HealthCheck: {},
  RunWorker: {
    workerId: WorkerId,
    connectionGeneration: PositiveInt,
    tunnelUrl: S.URLFromString,
    admissionLimit: PositiveInt,
  },
});
export type WorkerInvocation = typeof WorkerInvocation.Type;

export const WorkerInvocationResult = S.TaggedUnion({
  Healthy: {
    service: S.Literal("lambda-fluid-worker"),
    effectVersion: S.NonEmptyString,
    checkedAtEpochMs: PositiveInt,
  },
  WorkerStopped: {
    workerId: WorkerId,
    stoppedAtEpochMs: PositiveInt,
  },
});
export type WorkerInvocationResult = typeof WorkerInvocationResult.Type;
