import { NodeSocket } from "@effect/platform-node";
import {
  WorkerHealthSnapshot,
  WorkerRegistration,
  type WorkerId,
} from "@lambda-fluid/protocol";
import {
  makeWorkerRuntime,
  runWorkerTunnelSession,
  type JobHandler,
} from "@lambda-fluid/worker";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import * as Socket from "effect/unstable/socket/Socket";

import { WorkerInvocation, WorkerInvocationResult } from "./invocation.js";

const lambdaTimeoutMs = 15 * 60_000;
const drainBeforeTimeoutMs = 60_000;
const shutdownGraceMs = 5_000;

export interface LambdaContext {
  readonly getRemainingTimeInMillis: () => number;
  readonly memoryLimitInMB: string;
}

const makeInitialHealth = (
  workerId: WorkerId,
  connectionGeneration: number,
  sampledAtEpochMs: number,
  memoryLimitBytes: number
) => {
  const memory = process.memoryUsage();
  return WorkerHealthSnapshot.make({
    workerId,
    connectionGeneration,
    snapshotSequence: 0,
    sampledAtEpochMs,
    inFlight: 0,
    inFlightHighWater: 0,
    cpuUsedMicros: 0,
    sampleIntervalMicros: 1_000_000,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    memoryLimitBytes,
    eventLoopLagMicros: 0,
    admissionState: "Accepting",
  });
};

const runWorker = Effect.fn("AwsLambdaWorker.run")(function* (
  invocation: Extract<WorkerInvocation, { readonly _tag: "RunWorker" }>,
  context: LambdaContext,
  handler: JobHandler
) {
  const remainingMs = Math.min(lambdaTimeoutMs, context.getRemainingTimeInMillis());
  const startedAtEpochMs = yield* Clock.currentTimeMillis;
  const runtime = yield* makeWorkerRuntime({
    workerId: invocation.workerId,
    connectionGeneration: invocation.connectionGeneration,
    admissionLimit: invocation.admissionLimit,
    outboundCapacity: Math.max(64, invocation.admissionLimit * 4),
    handler,
  });
  const socket = yield* Socket.makeWebSocket(invocation.tunnelUrl.toString()).pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructor)
  );

  // Stop admission before AWS reaches its hard wall, then allow scoped cleanup.
  yield* Effect.sleep(Math.max(0, remainingMs - drainBeforeTimeoutMs)).pipe(
    Effect.andThen(runtime.beginDrain),
    Effect.forkScoped
  );

  yield* runWorkerTunnelSession({
    socket,
    registration: WorkerRegistration.make({
      protocolVersion: 1,
      workerId: invocation.workerId,
      maxConcurrency: invocation.admissionLimit,
      connectionGeneration: invocation.connectionGeneration,
      invocationDeadlineEpochMs: startedAtEpochMs + remainingMs,
    }),
    initialHealth: makeInitialHealth(
      invocation.workerId,
      invocation.connectionGeneration,
      startedAtEpochMs,
      Number(context.memoryLimitInMB) * 1024 * 1024
    ),
    runtime,
  }).pipe(
    Effect.catchTag("SocketError", () => Effect.void),
    Effect.timeoutOrElse({
      duration: Duration.millis(Math.max(1, remainingMs - shutdownGraceMs)),
      orElse: () => Effect.void,
    })
  );

  return WorkerInvocationResult.cases.WorkerStopped.make({
    workerId: invocation.workerId,
    stoppedAtEpochMs: yield* Clock.currentTimeMillis,
  });
});

/** Adapts an ordinary application handler to AWS Lambda's invocation boundary. */
export const makeLambdaWorkerHandler =
  (handler: JobHandler) =>
  (input: unknown, context: LambdaContext): Promise<WorkerInvocationResult> =>
    S.decodeUnknownEffect(WorkerInvocation)(input).pipe(
      Effect.flatMap((invocation) => {
        if (invocation._tag === "RunWorker") {
          return Effect.scoped(runWorker(invocation, context, handler)).pipe(
            Effect.map((result): WorkerInvocationResult => result)
          );
        }

        return Effect.succeed(
          WorkerInvocationResult.cases.Healthy.make({
            service: "lambda-fluid-worker",
            effectVersion: "4.0.0-beta.98",
            checkedAtEpochMs: Date.now(),
          })
        ).pipe(Effect.map((result): WorkerInvocationResult => result));
      }),
      Effect.runPromise
    );
