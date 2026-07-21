import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { OrchestratorControlPlane } from "./control-plane.js";

/** Upgrades one HTTP request and owns the worker session until its socket closes. */
export const makeWorkerWebSocketHandler = (controlPlane: OrchestratorControlPlane) =>
  Effect.fn("Orchestrator.handleWorkerWebSocket")(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    // A worker tunnel ending is the normal lifecycle boundary for this upgraded
    // request; the fleet registry cleanup lives inside runWorkerSession.
    yield* controlPlane
      .runWorkerSession(socket)
      .pipe(Effect.catchTag("SocketError", () => Effect.void));
    return HttpServerResponse.empty();
  });
