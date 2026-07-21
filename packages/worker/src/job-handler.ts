import {
  JobAccepted,
  ResponseBodyChunk,
  ResponseEnd,
  ResponseFailed,
  ResponseStarted,
  type HttpStatusCode,
  type JobRequest,
  type ResponseHeaders,
  type WorkerId,
  type WorkerToOrchestratorFrame,
} from "@lambda-fluid/protocol";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export interface HandlerContext {
  readonly signal: AbortSignal;
}

export interface HandlerResponse {
  readonly statusCode: HttpStatusCode;
  readonly headers: ResponseHeaders;
  readonly bodyChunks: ReadonlyArray<string>;
  readonly delayBetweenChunksMs: number;
}

export type JobHandler = (
  request: JobRequest,
  context: HandlerContext
) => HandlerResponse | PromiseLike<HandlerResponse>;

type HandlerOutcome = Data.TaggedEnum<{
  Succeeded: { readonly response: HandlerResponse };
  HandlerFailed: {};
  DeadlineExceeded: {};
}>;

const HandlerOutcome = Data.taggedEnum<HandlerOutcome>();

export interface JobHandlerDependencies {
  readonly workerId: WorkerId;
  readonly connectionGeneration: number;
  readonly handler: JobHandler;
  readonly emit: (frame: WorkerToOrchestratorFrame) => Effect.Effect<void>;
  readonly complete: (request: JobRequest) => Effect.Effect<void>;
}

const failureFrame = (
  request: JobRequest,
  reason: "HandlerFailure" | "DeadlineExceeded"
) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((failedAtEpochMs) =>
      ResponseFailed.make({
        requestId: request.requestId,
        attemptId: request.attemptId,
        failedAtEpochMs,
        reason,
      })
    )
  );

const emitResponse = (
  dependencies: JobHandlerDependencies,
  request: JobRequest,
  response: HandlerResponse
) =>
  Effect.gen(function* () {
    yield* dependencies.emit(
      ResponseStarted.make({
        requestId: request.requestId,
        attemptId: request.attemptId,
        workerId: dependencies.workerId,
        statusCode: response.statusCode,
        headers: response.headers,
        startedAtEpochMs: yield* Clock.currentTimeMillis,
      })
    );

    for (let sequence = 0; sequence < response.bodyChunks.length; sequence++) {
      if (sequence > 0 && response.delayBetweenChunksMs > 0) {
        yield* Effect.sleep(Duration.millis(response.delayBetweenChunksMs));
      }
      yield* dependencies.emit(
        ResponseBodyChunk.make({
          requestId: request.requestId,
          attemptId: request.attemptId,
          sequence,
          body: response.bodyChunks[sequence],
        })
      );
    }

    yield* dependencies.emit(
      ResponseEnd.make({
        requestId: request.requestId,
        attemptId: request.attemptId,
        completedAtEpochMs: yield* Clock.currentTimeMillis,
        totalChunks: response.bodyChunks.length,
      })
    );
  });

/** Builds the supervised operation for one accepted logical request. */
export const makeJobHandler = (dependencies: JobHandlerDependencies) =>
  Effect.fn("Worker.handleJob")(
    function* (request: JobRequest) {
      yield* dependencies.emit(
        JobAccepted.make({
          requestId: request.requestId,
          attemptId: request.attemptId,
          workerId: dependencies.workerId,
          connectionGeneration: dependencies.connectionGeneration,
          acceptedAtEpochMs: yield* Clock.currentTimeMillis,
        })
      );

      const now = yield* Clock.currentTimeMillis;
      const remainingMs = Math.max(0, request.deadlineEpochMs - now);
      const outcome = yield* Effect.tryPromise((signal) =>
        Promise.resolve(dependencies.handler(request, { signal }))
      ).pipe(
        Effect.map((response) => HandlerOutcome.Succeeded({ response })),
        Effect.catch(() => Effect.succeed(HandlerOutcome.HandlerFailed())),
        Effect.timeoutOrElse({
          duration: Duration.millis(remainingMs),
          orElse: () => Effect.succeed(HandlerOutcome.DeadlineExceeded()),
        })
      );

      yield* HandlerOutcome.$match(outcome, {
        HandlerFailed: () =>
          failureFrame(request, "HandlerFailure").pipe(
            Effect.flatMap(dependencies.emit)
          ),
        DeadlineExceeded: () =>
          failureFrame(request, "DeadlineExceeded").pipe(
            Effect.flatMap(dependencies.emit)
          ),
        Succeeded: ({ response }) => emitResponse(dependencies, request, response),
      });
    },
    (effect, request) => effect.pipe(Effect.ensuring(dependencies.complete(request)))
  );
