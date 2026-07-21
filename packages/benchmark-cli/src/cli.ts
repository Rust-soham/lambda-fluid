#!/usr/bin/env node

import {
  NodeHttpClient,
  NodeHttpServer,
  NodeRuntime,
  NodeSocket,
  NodeSocketServer,
} from "@effect/platform-node";
import type { BenchmarkDefinition } from "@lambda-fluid/benchmark";
import {
  makeAdaptiveCapacity,
  makeBenchmarkHttpHandler,
  makeOrchestratorControlPlane,
} from "@lambda-fluid/orchestrator";
import {
  WorkerHealthSnapshot,
  WorkerId,
  WorkerRegistration,
} from "@lambda-fluid/protocol";
import { makeWorkerRuntime, runWorkerTunnelSession } from "@lambda-fluid/worker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as S from "effect/Schema";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { createServer } from "node:http";

import { loadDefinition } from "./load-definition.js";
import {
  renderReport,
  runNormalLambda,
  type BatchMeasurement,
  type FluidMeasurement,
} from "./report.js";

// oxfmt-ignore
class BenchmarkCliError
  extends S.TaggedErrorClass<BenchmarkCliError>()("BenchmarkCliError", {
    message: S.String,
  }) {}

interface LocalWorkerMeasurement {
  readonly runtime: Effect.Success<ReturnType<typeof makeWorkerRuntime>>;
  readonly launchedAtEpochMs: number;
}

const localFleet = {
  slotsPerWorker: 8,
  maxWorkers: 4,
  spreadAtConcurrency: 9,
  packBelowConcurrency: 4,
} as const;

const runFluid = Effect.fn("Bench.runFluid")(function* (
  definition: BenchmarkDefinition
) {
  const controlPlane = yield* makeOrchestratorControlPlane({
    initialAdmissionLimit: localFleet.slotsPerWorker,
  });
  const tunnelServer = yield* NodeSocketServer.make({
    host: "127.0.0.1",
    port: 0,
  });
  yield* tunnelServer.run(controlPlane.runWorkerSession).pipe(Effect.forkScoped);

  if (tunnelServer.address._tag !== "TcpAddress") {
    return yield* BenchmarkCliError.make({
      message: "benchmark tunnel requires a TCP address",
    });
  }
  const tunnelPort = tunnelServer.address.port;

  const workers = yield* Ref.make<ReadonlyArray<LocalWorkerMeasurement>>([]);
  const workerFibers = yield* FiberSet.make<void>();
  const launch = Effect.fn("Bench.launchLocalWorker")(function* (workerNumber: number) {
    const workerId = WorkerId.make(`benchmark-worker-${workerNumber}`);
    const worker = Effect.scoped(
      Effect.gen(function* () {
        const workerSocket = yield* NodeSocket.makeNet({
          host: "127.0.0.1",
          port: tunnelPort,
        });
        const runtime = yield* makeWorkerRuntime({
          workerId,
          connectionGeneration: 1,
          admissionLimit: localFleet.slotsPerWorker,
          outboundCapacity: Math.max(64, definition.requests.length * 4),
          handler: definition.handler,
        });
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.update(workers, (current) => [
          ...current,
          { runtime, launchedAtEpochMs: now },
        ]);
        yield* runWorkerTunnelSession({
          socket: workerSocket,
          registration: WorkerRegistration.make({
            protocolVersion: 1,
            workerId,
            maxConcurrency: localFleet.slotsPerWorker,
            connectionGeneration: 1,
            invocationDeadlineEpochMs: now + 15 * 60_000,
          }),
          initialHealth: WorkerHealthSnapshot.make({
            workerId,
            connectionGeneration: 1,
            snapshotSequence: 0,
            sampledAtEpochMs: now,
            inFlight: 0,
            inFlightHighWater: 0,
            cpuUsedMicros: 0,
            sampleIntervalMicros: 1_000_000,
            rssBytes: 1,
            heapUsedBytes: 1,
            memoryLimitBytes: 1_024,
            eventLoopLagMicros: 0,
            admissionState: "Accepting",
          }),
          runtime,
        });
      })
    );
    yield* FiberSet.run(workerFibers, worker);
    yield* controlPlane.awaitWorker(workerId);
  });
  const capacity = yield* makeAdaptiveCapacity({ ...localFleet, launch });

  const httpLive = HttpRouter.serve(
    HttpRouter.add("*", "*", makeBenchmarkHttpHandler(controlPlane, capacity)()),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
    )
  );
  const httpContext = yield* Layer.build(httpLive);
  const httpServer = Context.get(httpContext, HttpServer.HttpServer);
  if (httpServer.address._tag !== "TcpAddress") {
    return yield* BenchmarkCliError.make({
      message: "benchmark HTTP server requires TCP",
    });
  }

  const origin = `http://127.0.0.1:${httpServer.address.port}`;
  const client = yield* HttpClient.HttpClient;
  const batchStartedAt = yield* Clock.currentTimeMillis;
  const requests = yield* Effect.forEach(
    definition.requests,
    Effect.fn("Bench.runFluidRequest")(function* (benchmarkRequest) {
      const startedAt = yield* Clock.currentTimeMillis;
      const applicationRequest = benchmarkRequest.request;
      const headers = Object.fromEntries(
        Object.entries(applicationRequest.headers).flatMap(([name, values]) =>
          values[0] === undefined ? [] : [[name, values[0]]]
        )
      );
      const outgoing = HttpClientRequest.make(applicationRequest.method)(
        `${origin}${applicationRequest.path}`,
        {
          headers,
          body: HttpBody.text(applicationRequest.body),
        }
      );
      yield* client.execute(outgoing).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text)
      );
      return { wallMs: (yield* Clock.currentTimeMillis) - startedAt };
    }),
    { concurrency: "unbounded" }
  );
  const batchCompletedAt = yield* Clock.currentTimeMillis;
  const workerMeasurements = yield* Ref.get(workers);
  const workerStates = yield* Effect.forEach(
    workerMeasurements,
    ({ runtime }) => runtime.snapshot
  );
  const capacityState = yield* capacity.snapshot;

  return {
    batch: {
      elapsedMs: batchCompletedAt - batchStartedAt,
      requests,
    } satisfies BatchMeasurement,
    peakInFlight: workerStates.reduce(
      (peak, worker) => Math.max(peak, worker.inFlightHighWater),
      0
    ),
    workerInvocations: capacityState.peakWorkers,
    totalWorkerIntervalMs: workerMeasurements.reduce(
      (total, worker) => total + batchCompletedAt - worker.launchedAtEpochMs,
      0
    ),
  } satisfies FluidMeasurement;
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const examplePath = process.argv[2];
    if (examplePath === undefined) {
      return yield* BenchmarkCliError.make({
        message: "usage: bench <example.ts>",
      });
    }
    const definition = yield* loadDefinition(examplePath);
    const normal = yield* runNormalLambda(definition);
    const fluid = yield* runFluid(definition);
    yield* Effect.sync(() =>
      process.stdout.write(
        renderReport(definition, normal, fluid, localFleet, "Local idealized model")
      )
    );
  })
).pipe(
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.catch((error) =>
    Effect.sync(() => {
      process.stderr.write(`bench: ${String(error)}\n`);
      process.exitCode = 1;
    })
  )
);

NodeRuntime.runMain(program);
