import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  AttemptId,
  JobRequest,
  RequestId,
  SyntheticWorkload,
  decodeFrameChunk,
  decodeOrchestratorPayload,
  emptyFrameDecoderState,
  encodeFrame,
  encodeOrchestratorFrame,
} from "../src/index.js";

const payload = (text: string): Uint8Array => new TextEncoder().encode(text);

const frame = (text: string): Uint8Array => {
  const result = encodeFrame(payload(text));
  if (Result.isFailure(result)) assert.fail(result.failure.reason);
  return result.success;
};

describe("length-prefixed framing", () => {
  it("retains fragmented input until one complete frame is available", () => {
    const encoded = frame("fragmented");
    const first = decodeFrameChunk(emptyFrameDecoderState(), encoded.slice(0, 3));
    if (Result.isFailure(first)) assert.fail(first.failure.reason);
    assert.lengthOf(first.success.payloads, 0);

    const second = decodeFrameChunk(first.success.state, encoded.slice(3, 7));
    if (Result.isFailure(second)) assert.fail(second.failure.reason);
    assert.lengthOf(second.success.payloads, 0);

    const third = decodeFrameChunk(second.success.state, encoded.slice(7));
    if (Result.isFailure(third)) assert.fail(third.failure.reason);
    assert.deepEqual(third.success.payloads, [payload("fragmented")]);
    assert.lengthOf(third.success.state.buffered, 0);
  });

  it("emits every coalesced frame from one TCP chunk", () => {
    const first = frame("one");
    const second = frame("two");
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first);
    combined.set(second, first.length);

    const decoded = decodeFrameChunk(emptyFrameDecoderState(), combined);
    if (Result.isFailure(decoded)) assert.fail(decoded.failure.reason);
    assert.deepEqual(decoded.success.payloads, [payload("one"), payload("two")]);
  });

  it("rejects a length prefix above the configured maximum", () => {
    const decoded = decodeFrameChunk(
      emptyFrameDecoderState(),
      new Uint8Array([0, 0, 1, 0]),
      128
    );
    if (Result.isSuccess(decoded)) assert.fail("Expected oversized frame failure");
    assert.strictEqual(decoded.failure.reason, "FrameTooLarge");
  });

  it.effect("round-trips a typed frame through Schema JSON and byte framing", () =>
    Effect.gen(function* () {
      const request = JobRequest.make({
        protocolVersion: 1,
        requestId: RequestId.make("request-1"),
        attemptId: AttemptId.make("attempt-1"),
        sentAtEpochMs: 1_000,
        deadlineEpochMs: 31_000,
        retrySafety: "RetrySafe",
        workload: SyntheticWorkload.make({
          firstCpuMs: 5,
          ioDelayMs: 100,
          secondCpuMs: 5,
          responseChunks: 3,
          delayBetweenChunksMs: 20,
        }),
      });

      const encoded = yield* encodeOrchestratorFrame(request);
      const framed = decodeFrameChunk(emptyFrameDecoderState(), encoded);
      if (Result.isFailure(framed)) assert.fail(framed.failure.reason);
      const decoded = yield* decodeOrchestratorPayload(framed.success.payloads[0]);

      assert.deepEqual(decoded, request);
    })
  );
});
