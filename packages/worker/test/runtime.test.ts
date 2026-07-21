import { assert, describe, it } from "@effect/vitest";
import {
  AttemptId,
  ApplicationRequest,
  HttpStatusCode,
  JobRequest,
  RequestId,
  WorkerId,
  type WorkerToOrchestratorFrame,
} from "@lambda-fluid/protocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { JobHandler } from "../src/job-handler.js";
import { makeWorkerRuntime } from "../src/runtime.js";

const workerId = WorkerId.make("worker-1");

const testHandler: JobHandler = async (job, { signal }) => {
  const input = JSON.parse(job.request.body);
  if (
    typeof input !== "object" ||
    input === null ||
    !("ioDelayMs" in input) ||
    typeof input.ioDelayMs !== "number" ||
    !("responseChunks" in input) ||
    typeof input.responseChunks !== "number"
  ) {
    throw new Error("invalid test request");
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, input.ioDelayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true }
    );
  });
  return {
    statusCode: HttpStatusCode.make(200),
    headers: { "content-type": ["text/plain"] },
    bodyChunks: Array.from(
      { length: input.responseChunks },
      (_, index) => `${job.requestId}:${index}`
    ),
    delayBetweenChunksMs: 0,
  };
};

const request = (name: string, ioDelayMs: number, responseChunks = 1): JobRequest =>
  JobRequest.make({
    protocolVersion: 1,
    requestId: RequestId.make(`request-${name}`),
    attemptId: AttemptId.make(`attempt-${name}`),
    sentAtEpochMs: Date.now(),
    deadlineEpochMs: Date.now() + 10_000,
    retrySafety: "RetrySafe",
    request: ApplicationRequest.make({
      method: "POST",
      path: "/test",
      headers: { "content-type": ["application/json"] },
      body: JSON.stringify({ ioDelayMs, responseChunks }),
    }),
  });

const makeRuntime = (admissionLimit: number) =>
  makeWorkerRuntime({
    workerId,
    connectionGeneration: 1,
    admissionLimit,
    outboundCapacity: 32,
    handler: testHandler,
  });

const collect = (frames: Stream.Stream<WorkerToOrchestratorFrame>, count: number) =>
  frames.pipe(Stream.take(count), Stream.runCollect);

describe("local worker runtime", () => {
  it.effect("runs another logical request while the first awaits I/O", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime(2);
        const slow = request("slow", 50);
        const fast = request("fast", 0);

        yield* Effect.all([runtime.submit(slow), runtime.submit(fast)], {
          concurrency: "unbounded",
        });
        const frames = yield* collect(runtime.frames, 8);

        const slowEnd = frames.findIndex(
          (frame) => frame._tag === "ResponseEnd" && frame.requestId === slow.requestId
        );
        const fastEnd = frames.findIndex(
          (frame) => frame._tag === "ResponseEnd" && frame.requestId === fast.requestId
        );
        assert.isAtLeast(slowEnd, 0);
        assert.isAtLeast(fastEnd, 0);
        assert.isBelow(fastEnd, slowEnd);

        const snapshot = yield* runtime.snapshot;
        assert.strictEqual(snapshot.activeAttempts.size, 0);
        assert.strictEqual(snapshot.inFlightHighWater, 2);
      })
    )
  );

  it.effect("nacks immediately when the worker has no admission capacity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeRuntime(1);
        const first = request("first", 100);
        const second = request("second", 0);

        yield* runtime.submit(first);
        yield* runtime.submit(second);
        const frames = yield* collect(runtime.frames, 2);

        assert.strictEqual(frames[0]._tag, "JobAccepted");
        assert.strictEqual(frames[1]._tag, "JobNack");
        if (frames[1]._tag === "JobNack") {
          assert.strictEqual(frames[1].reason, "AtCapacity");
          assert.strictEqual(frames[1].attemptId, second.attemptId);
        }
      })
    )
  );

  it.effect(
    "interrupts the exact attempt and emits a cancellation terminal frame",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(1);
          const job = request("cancelled", 1_000);

          yield* runtime.submit(job);
          const accepted = yield* collect(runtime.frames, 1);
          assert.strictEqual(accepted[0]._tag, "JobAccepted");

          yield* runtime.cancel(job.requestId, job.attemptId, Date.now());
          const cancelled = yield* collect(runtime.frames, 1);
          assert.strictEqual(cancelled[0]._tag, "ResponseFailed");
          if (cancelled[0]._tag === "ResponseFailed") {
            assert.strictEqual(cancelled[0].reason, "Cancelled");
            assert.strictEqual(cancelled[0].attemptId, job.attemptId);
          }

          const snapshot = yield* runtime.snapshot;
          assert.strictEqual(snapshot.activeAttempts.size, 0);
        })
      )
  );
});
