import { Schema as S } from "effect";

import { NonNegativeInt } from "./base.js";
import { HttpStatusCode, RequestId, WorkerId } from "./identifiers.js";

export const ResponseFrame = S.TaggedUnion({
  ResponseStarted: {
    requestId: RequestId,
    workerId: WorkerId,
    statusCode: HttpStatusCode,
    startedAtEpochMs: NonNegativeInt,
  },
  ResponseBodyChunk: {
    requestId: RequestId,
    sequence: NonNegativeInt,
    body: S.String,
  },
  ResponseEnd: {
    requestId: RequestId,
    completedAtEpochMs: NonNegativeInt,
    totalChunks: NonNegativeInt,
  },
});

export type ResponseFrame = typeof ResponseFrame.Type;

export const ResponseStarted = ResponseFrame.cases.ResponseStarted;
export type ResponseStarted = typeof ResponseStarted.Type;

export const ResponseBodyChunk = ResponseFrame.cases.ResponseBodyChunk;
export type ResponseBodyChunk = typeof ResponseBodyChunk.Type;

export const ResponseEnd = ResponseFrame.cases.ResponseEnd;
export type ResponseEnd = typeof ResponseEnd.Type;
