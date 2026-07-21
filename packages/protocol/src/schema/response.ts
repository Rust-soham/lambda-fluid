import * as S from "effect/Schema";

import { NonNegativeInt } from "./base.js";
import { AttemptId, HttpStatusCode, RequestId, WorkerId } from "./identifiers.js";

export const ResponseFailureReason = S.Literals([
  "HandlerFailure",
  "DeadlineExceeded",
  "Cancelled",
]);
export type ResponseFailureReason = typeof ResponseFailureReason.Type;

// oxfmt-ignore
export class ResponseStarted 
  extends S.TaggedClass<ResponseStarted>()(
    "ResponseStarted",
    {
      requestId: RequestId,
      attemptId: AttemptId,
      workerId: WorkerId,
      statusCode: HttpStatusCode,
      startedAtEpochMs: NonNegativeInt,
    }
) {}

// oxfmt-ignore
export class ResponseBodyChunk 
  extends S.TaggedClass<ResponseBodyChunk>()(
    "ResponseBodyChunk",
    {
      requestId: RequestId,
      attemptId: AttemptId,
      sequence: NonNegativeInt,
      body: S.String,
    }
) {}

// oxfmt-ignore
export class ResponseEnd 
  extends S.TaggedClass<ResponseEnd>()(
    "ResponseEnd", 
    {
      requestId: RequestId,
      attemptId: AttemptId,
      completedAtEpochMs: NonNegativeInt,
      totalChunks: NonNegativeInt,
    }
) {}

// oxfmt-ignore
export class ResponseFailed
  extends S.TaggedClass<ResponseFailed>()(
    "ResponseFailed",
    {
      requestId: RequestId,
      attemptId: AttemptId,
      failedAtEpochMs: NonNegativeInt,
      reason: ResponseFailureReason,
    }
) {}

export const ResponseFrame = S.Union([
  ResponseStarted,
  ResponseBodyChunk,
  ResponseEnd,
  ResponseFailed,
]).pipe(S.toTaggedUnion("_tag"));

export type ResponseFrame = typeof ResponseFrame.Type;
