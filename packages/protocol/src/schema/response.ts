import * as S from "effect/Schema";

import { NonNegativeInt } from "./base.js";
import { HttpStatusCode, RequestId, WorkerId } from "./identifiers.js";

// oxfmt-ignore
export class ResponseStarted 
  extends S.TaggedClass<ResponseStarted>()(
    "ResponseStarted",
    {
      requestId: RequestId,
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
      completedAtEpochMs: NonNegativeInt,
      totalChunks: NonNegativeInt,
    }
) {}

export const ResponseFrame = S.Union([
  ResponseStarted,
  ResponseBodyChunk,
  ResponseEnd,
]).pipe(S.toTaggedUnion("_tag"));

export type ResponseFrame = typeof ResponseFrame.Type;
