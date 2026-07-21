import {
  NodeHttpServer,
  NodeRuntime,
  NodeSocket,
  NodeSocketServer,
} from "@effect/platform-node";
import {
  InventoryRequest,
  makeOrderHandler,
  type OrderEvent,
} from "@lambda-fluid/benchmark";
import {
  makeBenchmarkHttpHandler,
  makeOrchestratorControlPlane,
} from "@lambda-fluid/orchestrator";
import {
  WorkerHealthSnapshot,
  WorkerId,
  WorkerRegistration,
} from "@lambda-fluid/protocol";
import { makeWorkerRuntime, runWorkerTunnelSession } from "@lambda-fluid/worker";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpServerRequest } from "effect/unstable/http";
import { createServer } from "node:http";

const program = Effect.scoped(
  Effect.gen(function* () {
    const tunnelPort = yield* Config.number("TUNNEL_PORT").pipe(
      Config.withDefault(9000)
    );
    const httpPort = yield* Config.number("HTTP_PORT").pipe(Config.withDefault(3000));
    const inventoryPort = yield* Config.number("INVENTORY_PORT").pipe(
      Config.withDefault(3001)
    );
    const initialAdmissionLimit = yield* Config.number("INITIAL_ADMISSION_LIMIT").pipe(
      Config.withDefault(20)
    );
    const controlPlane = yield* makeOrchestratorControlPlane({
      initialAdmissionLimit,
    });
    const tunnelServer = yield* NodeSocketServer.make({
      host: "127.0.0.1",
      port: tunnelPort,
    });

    yield* tunnelServer.run(controlPlane.runWorkerSession).pipe(Effect.forkScoped);

    // The local demo worker uses the same outbound TCP path as a future Lambda worker.
    const workerId = WorkerId.make("local-worker-1");
    const workerSocket = yield* NodeSocket.makeNet({
      host: "127.0.0.1",
      port: tunnelPort,
    });
    const inventoryLive = HttpRouter.add(
      "POST",
      "/reserve",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.schemaBodyJson(InventoryRequest);
        yield* Effect.sleep(`${request.delayMs} millis`);
        return HttpServerResponse.jsonUnsafe({
          reservationId: crypto.randomUUID(),
          available: true,
        });
      })
    ).pipe(
      HttpRouter.serve,
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: "127.0.0.1",
          port: inventoryPort,
        })
      )
    );
    yield* Layer.build(inventoryLive);

    const events = yield* Queue.unbounded<OrderEvent>();
    yield* Stream.fromQueue(events).pipe(
      Stream.runForEach((event) =>
        Effect.logInfo(event.phase).pipe(
          Effect.annotateLogs({
            requestId: event.requestId,
            atEpochMs: event.atEpochMs,
          })
        )
      ),
      Effect.forkScoped
    );
    const runtime = yield* makeWorkerRuntime({
      workerId,
      connectionGeneration: 1,
      admissionLimit: initialAdmissionLimit,
      outboundCapacity: 64,
      handler: makeOrderHandler({
        inventoryUrl: `http://127.0.0.1:${inventoryPort}/reserve`,
        onEvent: (event) => {
          Queue.offerUnsafe(events, event);
        },
      }),
    });
    const now = Date.now();

    yield* runWorkerTunnelSession({
      socket: workerSocket,
      registration: WorkerRegistration.make({
        protocolVersion: 1,
        workerId,
        maxConcurrency: 32,
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
    }).pipe(Effect.forkScoped);

    yield* controlPlane.workerRegistrations.pipe(Stream.take(1), Stream.runDrain);

    const benchmarkHandler = makeBenchmarkHttpHandler(controlPlane);
    const httpLive = HttpRouter.add(
      "*",
      "*",
      benchmarkHandler().pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: "No worker capacity is currently available" },
              { status: 503 }
            )
          )
        )
      )
    ).pipe(
      HttpRouter.serve,
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: "127.0.0.1",
          port: httpPort,
        })
      )
    );

    yield* Layer.build(httpLive);
    yield* Effect.logInfo(
      `local Lambda Fluid demo listening at http://127.0.0.1:${httpPort}`
    );
    yield* Effect.never;
  })
);

NodeRuntime.runMain(program);
