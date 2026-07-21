import {
  AttemptId,
  ApplicationRequest,
  JobRequest,
  RequestId,
  type ResponseFrame,
} from "@lambda-fluid/protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { OrchestratorControlPlane } from "./control-plane.js";
import type { AdaptiveCapacity } from "./adaptive-capacity.js";
import { DispatchError } from "./control-plane.js";
import { RoutingPolicy } from "./fleet-state.js";

const requestTimeoutMs = 30_000;

const isBodyChunk = (
  frame: ResponseFrame
): frame is Extract<ResponseFrame, { readonly _tag: "ResponseBodyChunk" }> =>
  frame._tag === "ResponseBodyChunk";

const isSomeBody = (body: Option.Option<string>): body is Option.Some<string> =>
  Option.isSome(body);

const requestHeaders = (
  headers: Readonly<Record<string, string | undefined>>
): Record<string, Array<string>> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, [value]]]
    )
  );

/** Translates a public HTTP request into the internal tunnel protocol. */
export const makeApplicationHttpHandler = (
  controlPlane: OrchestratorControlPlane,
  capacity?: AdaptiveCapacity,
  defaultPolicy: RoutingPolicy = RoutingPolicy.Pack()
) =>
  Effect.fn("Orchestrator.handleApplicationHttp")(function* () {
    const lease =
      capacity === undefined
        ? { policy: defaultPolicy, release: Effect.void }
        : yield* capacity.acquire();
    const incoming = yield* HttpServerRequest.HttpServerRequest;
    const requestBody = yield* incoming.text;
    const now = yield* Clock.currentTimeMillis;
    const request = JobRequest.make({
      protocolVersion: 1,
      requestId: RequestId.make(crypto.randomUUID()),
      attemptId: AttemptId.make(crypto.randomUUID()),
      sentAtEpochMs: now,
      deadlineEpochMs: now + requestTimeoutMs,
      retrySafety: "NonRetryable",
      request: ApplicationRequest.make({
        method: incoming.method,
        path: incoming.url,
        headers: requestHeaders(incoming.headers),
        body: requestBody,
      }),
    });
    const [first, remainder] = yield* controlPlane
      .responses(request, lease.policy)
      .pipe(
        Stream.peel(Sink.head<ResponseFrame>()),
        Effect.onError(() => lease.release)
      );

    if (Option.isNone(first) || first.value._tag !== "ResponseStarted") {
      return yield* Effect.fail(DispatchError.make({ reason: "ProtocolViolation" }));
    }

    // Internal correlation and lifecycle frames never cross the client boundary.
    const responseBody = remainder.pipe(
      Stream.mapEffect((frame) => {
        if (isBodyChunk(frame)) return Effect.succeed(Option.some(frame.body));
        if (frame._tag === "ResponseFailed") {
          return Effect.fail(DispatchError.make({ reason: "WorkerResponseFailed" }));
        }
        return Effect.succeed(Option.none<string>());
      }),
      Stream.filter(isSomeBody),
      Stream.map((body) => body.value),
      Stream.encodeText,
      Stream.ensuring(lease.release)
    );

    return HttpServerResponse.stream(responseBody, {
      status: first.value.statusCode,
      headers: first.value.headers,
    });
  });

/** Backward-compatible name for the current demo composition. */
export const makeBenchmarkHttpHandler = makeApplicationHttpHandler;
