import { NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  DirectAwsWorkerInvokerLive,
  makeAwsWorkerLauncher,
} from "@lambda-fluid/aws-runtime";
import type { BenchmarkRequest } from "@lambda-fluid/benchmark";
import {
  makeApplicationHttpHandler,
  makeOrchestratorControlPlane,
  makeWorkerWebSocketHandler,
  RoutingPolicy,
} from "@lambda-fluid/orchestrator";
import { loadDefinition } from "../../packages/benchmark-cli/src/load-definition.js";
import {
  renderReport,
  runNormalLambda,
  type BatchMeasurement,
  type FluidMeasurement,
} from "../../packages/benchmark-cli/src/report.js";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";

import { makeQuickTunnel, QuickTunnelProcessLive } from "../quick-tunnel.js";

// oxfmt-ignore
class AwsBenchmarkError
  extends S.TaggedErrorClass<AwsBenchmarkError>()("AwsBenchmarkError", {
    message: S.String,
  }) {}

const awsFleet = {
  slotsPerWorker: 8,
  maxWorkers: 4,
  spreadAtConcurrency: 9,
} as const;

const outgoingRequest = (origin: string, input: BenchmarkRequest) => {
  const headers = Object.fromEntries(
    Object.entries(input.request.headers).flatMap(([name, values]) =>
      values[0] === undefined ? [] : [[name, values[0]]]
    )
  );
  return HttpClientRequest.make(input.request.method)(
    `${origin}${input.request.path}`,
    {
      headers,
      body: HttpBody.text(input.request.body),
    }
  );
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const examplePath = process.argv[2];
    if (examplePath === undefined) {
      return yield* AwsBenchmarkError.make({
        message: "usage: demo:local-aws <example.ts>",
      });
    }

    const definition = yield* loadDefinition(examplePath);
    const normal = yield* runNormalLambda(definition);
    const functionName = yield* Config.string("AWS_WORKER_FUNCTION").pipe(
      Config.withDefault("lambda-fluid-worker")
    );
    const cloudflared = yield* Config.string("CLOUDFLARED_BIN").pipe(
      Config.withDefault("cloudflared")
    );
    const controlPlane = yield* makeOrchestratorControlPlane({
      initialAdmissionLimit: awsFleet.slotsPerWorker,
    });
    const tunnelToken = crypto.randomUUID();
    const tunnelPath: `/${string}` = `/worker-tunnel/${tunnelToken}`;
    const workerWebSocket = makeWorkerWebSocketHandler(controlPlane);
    const tunnelLive = HttpRouter.add("GET", tunnelPath, workerWebSocket()).pipe(
      HttpRouter.serve,
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, {
          host: "127.0.0.1",
          port: 0,
          gracefulShutdownTimeout: "1 second",
        })
      )
    );
    const tunnelContext = yield* Layer.build(tunnelLive);
    const tunnelServer = Context.get(tunnelContext, HttpServer.HttpServer);
    if (tunnelServer.address._tag !== "TcpAddress") {
      return yield* Effect.die(new Error("benchmark tunnel requires TCP"));
    }
    const quickTunnel = yield* makeQuickTunnel(
      new URL(`http://127.0.0.1:${tunnelServer.address.port}`),
      cloudflared
    );
    const workerTunnelUrl = new URL(tunnelPath, quickTunnel.publicUrl);
    workerTunnelUrl.protocol = "wss:";

    const launchWorker = yield* makeAwsWorkerLauncher({
      functionName,
      tunnelUrl: workerTunnelUrl,
      admissionLimit: awsFleet.slotsPerWorker,
      awaitWorker: controlPlane.awaitWorker,
    });
    const workerCount = Math.min(
      awsFleet.maxWorkers,
      Math.max(1, Math.ceil(definition.requests.length / awsFleet.slotsPerWorker))
    );
    const launchedAt = yield* Ref.make<ReadonlyArray<number>>([]);
    yield* Effect.forEach(
      Array.from({ length: workerCount }, (_, index) => index + 1),
      Effect.fn("AwsBenchmark.launchWorker")(function* (workerNumber) {
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Ref.update(launchedAt, (times) => [...times, startedAt]);
        yield* launchWorker(workerNumber);
      }),
      { concurrency: "unbounded", discard: true }
    );

    const applicationHandler = makeApplicationHttpHandler(
      controlPlane,
      undefined,
      RoutingPolicy.Spread()
    );
    const applicationLive = HttpRouter.add(
      "*",
      "*",
      applicationHandler().pipe(
        Effect.catch((error) =>
          HttpServerResponse.json({ error: error._tag }, { status: 503 })
        )
      )
    ).pipe(
      HttpRouter.serve,
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, {
          host: "127.0.0.1",
          port: 0,
          gracefulShutdownTimeout: "1 second",
        })
      )
    );
    const applicationContext = yield* Layer.build(applicationLive);
    const applicationServer = Context.get(applicationContext, HttpServer.HttpServer);
    if (applicationServer.address._tag !== "TcpAddress") {
      return yield* Effect.die(new Error("benchmark application requires TCP"));
    }
    const origin = `http://127.0.0.1:${applicationServer.address.port}`;
    const client = yield* HttpClient.HttpClient;
    const batchStartedAt = yield* Clock.currentTimeMillis;
    const requests = yield* Effect.forEach(
      definition.requests,
      Effect.fn("AwsBenchmark.runRequest")(function* (request) {
        const startedAt = yield* Clock.currentTimeMillis;
        yield* client.execute(outgoingRequest(origin, request)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.text)
        );
        return { wallMs: (yield* Clock.currentTimeMillis) - startedAt };
      }),
      { concurrency: "unbounded" }
    );
    const batchCompletedAt = yield* Clock.currentTimeMillis;
    const fleet = yield* controlPlane.fleet.snapshot;
    const launchTimes = yield* Ref.get(launchedAt);
    const fluid = {
      batch: {
        elapsedMs: batchCompletedAt - batchStartedAt,
        requests,
      } satisfies BatchMeasurement,
      peakInFlight: Math.max(
        0,
        ...Array.from(fleet.workers.values(), (worker) => worker.peakEffectiveLoad)
      ),
      workerInvocations: workerCount,
      totalWorkerIntervalMs: launchTimes.reduce(
        (total, startedAt) => total + batchCompletedAt - startedAt,
        0
      ),
    } satisfies FluidMeasurement;

    yield* Effect.sync(() =>
      process.stdout.write(
        renderReport(definition, normal, fluid, awsFleet, "AWS Lambda measurement")
      )
    );
  }).pipe(
    Effect.provide(DirectAwsWorkerInvokerLive),
    Effect.provide(QuickTunnelProcessLive),
    Effect.provide(NodeHttpClient.layerUndici)
  )
).pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      process.stderr.write(`demo:local-aws: ${String(error)}\n`);
      process.exitCode = 1;
    })
  )
);

NodeRuntime.runMain(program);
