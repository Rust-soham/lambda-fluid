import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import {
  DirectAwsWorkerInvokerLive,
  makeAwsWorkerLauncher,
} from "@lambda-fluid/aws-runtime";
import {
  makeApplicationHttpHandler,
  makeOrchestratorControlPlane,
  makeWorkerWebSocketHandler,
} from "@lambda-fluid/orchestrator";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { createServer } from "node:http";

import { makeQuickTunnel, QuickTunnelProcessLive } from "../quick-tunnel.js";

const program = Effect.scoped(
  Effect.gen(function* () {
    const applicationPort = yield* Config.number("HTTP_PORT").pipe(
      Config.withDefault(3000)
    );
    const tunnelPort = yield* Config.number("TUNNEL_PORT").pipe(
      Config.withDefault(9000)
    );
    const admissionLimit = yield* Config.number("INITIAL_ADMISSION_LIMIT").pipe(
      Config.withDefault(8)
    );
    const functionName = yield* Config.string("AWS_WORKER_FUNCTION").pipe(
      Config.withDefault("lambda-fluid-worker")
    );
    const cloudflared = yield* Config.string("CLOUDFLARED_BIN").pipe(
      Config.withDefault("cloudflared")
    );
    const tunnelToken = crypto.randomUUID();
    const tunnelPath: `/${string}` = `/worker-tunnel/${tunnelToken}`;
    const controlPlane = yield* makeOrchestratorControlPlane({
      initialAdmissionLimit: admissionLimit,
    });

    const workerWebSocket = makeWorkerWebSocketHandler(controlPlane);
    const tunnelLive = HttpRouter.add("GET", tunnelPath, workerWebSocket()).pipe(
      HttpRouter.serve,
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, {
          host: "127.0.0.1",
          port: tunnelPort,
        })
      )
    );
    const tunnelContext = yield* Layer.build(tunnelLive);
    const tunnelServer = Context.get(tunnelContext, HttpServer.HttpServer);
    if (tunnelServer.address._tag !== "TcpAddress") {
      return yield* Effect.die(new Error("local AWS mode requires a TCP HTTP server"));
    }
    const tunnelOrigin = new URL(`http://127.0.0.1:${tunnelServer.address.port}`);
    const quickTunnel = yield* makeQuickTunnel(tunnelOrigin, cloudflared);
    const workerTunnelUrl = new URL(tunnelPath, quickTunnel.publicUrl);
    workerTunnelUrl.protocol = "wss:";

    const launchWorker = yield* makeAwsWorkerLauncher({
      functionName,
      tunnelUrl: workerTunnelUrl,
      admissionLimit,
      awaitWorker: controlPlane.awaitWorker,
    });
    yield* launchWorker(1);

    const applicationHandler = makeApplicationHttpHandler(controlPlane);
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
          port: applicationPort,
        })
      )
    );
    yield* Layer.build(applicationLive);

    yield* Effect.logInfo(
      `local orchestrator -> AWS Lambda ready at http://127.0.0.1:${applicationPort}`
    );
    yield* Effect.never;
  }).pipe(
    Effect.provide(DirectAwsWorkerInvokerLive),
    Effect.provide(QuickTunnelProcessLive)
  )
);

NodeRuntime.runMain(program);
