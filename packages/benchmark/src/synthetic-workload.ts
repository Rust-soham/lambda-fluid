import {
  HttpStatusCode,
  SyntheticWorkload,
  type JobRequest,
} from "@lambda-fluid/protocol";
import type { HandlerContext, JobHandler } from "@lambda-fluid/worker";
import * as S from "effect/Schema";

const burnCpu = (durationMs: number): void => {
  const endsAt = performance.now() + durationMs;
  while (performance.now() < endsAt) {
    // This benchmark deliberately demonstrates CPU-bound tenant code.
  }
};

const abortableDelay = (durationMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, durationMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true }
    );
  });

export const syntheticHandler: JobHandler = async (
  request: JobRequest,
  { signal }: HandlerContext
) => {
  const workload = await S.decodeUnknownPromise(SyntheticWorkload)(
    JSON.parse(request.request.body)
  );
  burnCpu(workload.firstCpuMs);
  await abortableDelay(workload.ioDelayMs, signal);
  burnCpu(workload.secondCpuMs);

  return {
    statusCode: HttpStatusCode.make(200),
    headers: { "content-type": ["text/plain; charset=utf-8"] },
    bodyChunks: Array.from(
      { length: workload.responseChunks },
      (_, index) => `chunk-${index}`
    ),
    delayBetweenChunksMs: workload.delayBetweenChunksMs,
  };
};
