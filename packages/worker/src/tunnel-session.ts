import {
  OrchestratorToWorkerFrame,
  type WorkerHealthSnapshot,
  type WorkerRegistration,
  type WorkerToOrchestratorFrame,
} from "@lambda-fluid/protocol";
import { workerTunnelChannel } from "@lambda-fluid/tunnel";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as Socket from "effect/unstable/socket/Socket";

import type { WorkerRuntime } from "./runtime.js";

export interface WorkerTunnelSessionOptions {
  readonly socket: Socket.Socket;
  readonly registration: WorkerRegistration;
  readonly initialHealth: WorkerHealthSnapshot;
  readonly runtime: WorkerRuntime;
}

const handleOrchestratorFrame = (
  runtime: WorkerRuntime,
  frame: OrchestratorToWorkerFrame
): Effect.Effect<void> =>
  OrchestratorToWorkerFrame.match(frame, {
    RegistrationAccepted: () => Effect.void,
    JobRequest: (request) => runtime.submit(request),
    CancelJob: ({ requestId, attemptId, cancelledAtEpochMs }) =>
      runtime.cancel(requestId, attemptId, cancelledAtEpochMs),
    BeginDrain: () => runtime.beginDrain,
  });

/** Owns one worker's outbound tunnel until the socket closes or its scope ends. */
export const runWorkerTunnelSession = Effect.fn("WorkerTunnelSession.run")(function* (
  options: WorkerTunnelSessionOptions
) {
  const outbound = yield* Queue.unbounded<WorkerToOrchestratorFrame>();

  // Runtime job fibers and lifecycle reporting share one serialized socket writer.
  yield* options.runtime.frames.pipe(
    Stream.runForEach((frame) => Queue.offer(outbound, frame)),
    Effect.forkScoped
  );

  yield* Queue.offer(outbound, options.registration);
  yield* Queue.offer(outbound, options.initialHealth);

  yield* Stream.fromQueue(outbound).pipe(
    Stream.pipeThroughChannel(workerTunnelChannel(options.socket)),
    Stream.runForEach((frame) => handleOrchestratorFrame(options.runtime, frame))
  );
});
