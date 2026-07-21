import { NodeHttpServer, NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { syntheticHandler } from "@lambda-fluid/benchmark";
import {
  AttemptId,
  ApplicationRequest,
  JobRequest,
  RequestId,
  SyntheticWorkload,
  WorkerHealthSnapshot,
  WorkerId,
  WorkerRegistration,
} from "@lambda-fluid/protocol";
import { makeWorkerRuntime, runWorkerTunnelSession } from "@lambda-fluid/worker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import type * as SocketServer from "effect/unstable/socket/SocketServer";

import {
  makeBenchmarkHttpHandler,
  makeOrchestratorControlPlane,
  RoutingPolicy,
} from "../src/index.js";

describe("orchestrator control plane", () => {
  it.effect("runs a logical request through a real TCP worker tunnel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workerId = WorkerId.make("worker-1");
        const controlPlane = yield* makeOrchestratorControlPlane({
          initialAdmissionLimit: 20,
        });
        const server = yield* NodeSocketServer.make({
          host: "127.0.0.1",
          port: 0,
        });

        yield* server.run(controlPlane.runWorkerSession).pipe(Effect.forkScoped);

        const address = server.address as SocketServer.TcpAddress;
        const workerSocket = yield* NodeSocket.makeNet({
          host: "127.0.0.1",
          port: address.port,
        });
        const runtime = yield* makeWorkerRuntime({
          workerId,
          connectionGeneration: 1,
          admissionLimit: 20,
          outboundCapacity: 16,
          handler: syntheticHandler,
        });
        const now = Date.now();
        const registration = WorkerRegistration.make({
          protocolVersion: 1,
          workerId,
          maxConcurrency: 8,
          connectionGeneration: 1,
          invocationDeadlineEpochMs: now + 15 * 60_000,
        });
        const health = WorkerHealthSnapshot.make({
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
        });

        yield* runWorkerTunnelSession({
          socket: workerSocket,
          registration,
          initialHealth: health,
          runtime,
        }).pipe(Effect.forkScoped);

        const ready = yield* controlPlane.workerRegistrations.pipe(
          Stream.take(1),
          Stream.runCollect
        );
        assert.strictEqual(ready[0]?.workerId, workerId);

        const request = JobRequest.make({
          protocolVersion: 1,
          requestId: RequestId.make("request-1"),
          attemptId: AttemptId.make("attempt-1"),
          sentAtEpochMs: now,
          deadlineEpochMs: now + 10_000,
          retrySafety: "RetrySafe",
          request: ApplicationRequest.make({
            method: "POST",
            path: "/benchmark",
            headers: { "content-type": ["application/json"] },
            body: JSON.stringify(
              SyntheticWorkload.make({
                firstCpuMs: 0,
                ioDelayMs: 0,
                secondCpuMs: 0,
                responseChunks: 2,
                delayBetweenChunksMs: 0,
              })
            ),
          }),
        });
        const frames = yield* controlPlane
          .responses(request, RoutingPolicy.Pack())
          .pipe(Stream.runCollect);

        assert.deepStrictEqual(
          frames.map((frame) => frame._tag),
          ["ResponseStarted", "ResponseBodyChunk", "ResponseBodyChunk", "ResponseEnd"]
        );
        assert.strictEqual(
          frames
            .filter((frame) => frame._tag === "ResponseBodyChunk")
            .map((frame) => frame.body)
            .join(""),
          "chunk-0chunk-1"
        );

        const benchmarkHandler = makeBenchmarkHttpHandler(controlPlane);
        const httpLive = HttpRouter.add("*", "*", benchmarkHandler()).pipe(
          HttpRouter.serve,
          Layer.provideMerge(NodeHttpServer.layerTest)
        );
        const publicResponses = yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* Effect.forEach(
            Array.from({ length: 20 }, (_, index) => index),
            () =>
              client
                .post("/benchmark", {
                  body: HttpBody.jsonUnsafe({
                    firstCpuMs: 0,
                    ioDelayMs: 25,
                    secondCpuMs: 0,
                    responseChunks: 2,
                    delayBetweenChunksMs: 0,
                  }),
                })
                .pipe(
                  Effect.flatMap((response) =>
                    response.text.pipe(
                      Effect.map((body) => ({ status: response.status, body }))
                    )
                  )
                ),
            { concurrency: "unbounded" }
          );
        }).pipe(Effect.provide(httpLive));

        assert.lengthOf(publicResponses, 20);
        for (const response of publicResponses) {
          assert.strictEqual(response.status, 200);
          assert.strictEqual(response.body, "chunk-0chunk-1");
        }
        const workerState = yield* runtime.snapshot;
        assert.isAbove(workerState.inFlightHighWater, 1);
      })
    )
  );
});
