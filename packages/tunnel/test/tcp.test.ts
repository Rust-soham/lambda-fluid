import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AttemptId,
  JobAccepted,
  JobRequest,
  RequestId,
  SyntheticWorkload,
  WorkerId,
  type OrchestratorToWorkerFrame,
  type WorkerToOrchestratorFrame,
} from "@lambda-fluid/protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as SocketServer from "effect/unstable/socket/SocketServer";

import { orchestratorTunnelChannel, workerTunnelChannel } from "../src/channel.js";

describe("TCP tunnel", () => {
  it.effect("exchanges typed frames over a real loopback socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workerId = WorkerId.make("worker-1");
        const server = yield* NodeSocketServer.make({
          host: "127.0.0.1",
          port: 0,
        });

        yield* server
          .run((socket) =>
            Effect.scoped(
              Effect.gen(function* () {
                const outbound = yield* Queue.unbounded<WorkerToOrchestratorFrame>();

                yield* Stream.fromQueue(outbound).pipe(
                  Stream.pipeThroughChannel(workerTunnelChannel(socket)),
                  Stream.runForEach((frame) => {
                    if (frame._tag !== "JobRequest") return Effect.void;
                    return Clock.currentTimeMillis.pipe(
                      Effect.flatMap((acceptedAtEpochMs) =>
                        Queue.offer(
                          outbound,
                          JobAccepted.make({
                            requestId: frame.requestId,
                            attemptId: frame.attemptId,
                            workerId,
                            connectionGeneration: 1,
                            acceptedAtEpochMs,
                          })
                        )
                      ),
                      Effect.asVoid
                    );
                  })
                );
              })
            )
          )
          .pipe(Effect.forkScoped);

        const address = server.address as SocketServer.TcpAddress;
        const socket = yield* NodeSocket.makeNet({
          host: "127.0.0.1",
          port: address.port,
        });
        const request = JobRequest.make({
          protocolVersion: 1,
          requestId: RequestId.make("request-1"),
          attemptId: AttemptId.make("attempt-1"),
          sentAtEpochMs: Date.now(),
          deadlineEpochMs: Date.now() + 10_000,
          retrySafety: "RetrySafe",
          workload: SyntheticWorkload.make({
            firstCpuMs: 0,
            ioDelayMs: 0,
            secondCpuMs: 0,
            responseChunks: 1,
            delayBetweenChunksMs: 0,
          }),
        });

        const clientOutbound = yield* Queue.unbounded<OrchestratorToWorkerFrame>();
        yield* Queue.offer(clientOutbound, request);
        const responses = yield* Stream.fromQueue(clientOutbound).pipe(
          Stream.pipeThroughChannel(orchestratorTunnelChannel(socket)),
          Stream.take(1),
          Stream.runCollect
        );

        assert.lengthOf(responses, 1);
        assert.strictEqual(responses[0]._tag, "JobAccepted");
        if (responses[0]._tag === "JobAccepted") {
          assert.strictEqual(responses[0].requestId, request.requestId);
          assert.strictEqual(responses[0].attemptId, request.attemptId);
        }
      })
    )
  );
});
