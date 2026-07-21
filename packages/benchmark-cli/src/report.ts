import type { BenchmarkDefinition, BenchmarkRequest } from "@lambda-fluid/benchmark";
import { AttemptId, JobRequest, RequestId } from "@lambda-fluid/protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export interface RequestMeasurement {
  readonly wallMs: number;
}

export interface BatchMeasurement {
  readonly elapsedMs: number;
  readonly requests: ReadonlyArray<RequestMeasurement>;
}

export interface FluidMeasurement {
  readonly batch: BatchMeasurement;
  readonly peakInFlight: number;
  readonly workerInvocations: number;
  readonly totalWorkerIntervalMs: number;
}

/** Constructs the internal request used by baseline and Fluid measurements. */
export const makeJobRequest = (
  benchmarkRequest: BenchmarkRequest,
  requestNumber: number,
  now: number
) =>
  JobRequest.make({
    protocolVersion: 1,
    requestId: RequestId.make(`request-${requestNumber + 1}`),
    attemptId: AttemptId.make(`baseline-${requestNumber + 1}`),
    sentAtEpochMs: now,
    deadlineEpochMs: now + 30_000,
    retrySafety: benchmarkRequest.retrySafety,
    request: benchmarkRequest.request,
  });

/** Measures the conventional one-environment-per-request baseline locally. */
export const runNormalLambda = Effect.fn("Bench.runNormalLambda")(function* (
  definition: BenchmarkDefinition
) {
  const batchStartedAt = yield* Clock.currentTimeMillis;
  const requests = yield* Effect.forEach(
    definition.requests,
    Effect.fn("Bench.runNormalLambdaRequest")(
      function* (benchmarkRequest, requestNumber) {
        const startedAt = yield* Clock.currentTimeMillis;
        const request = makeJobRequest(benchmarkRequest, requestNumber, startedAt);
        yield* Effect.tryPromise((signal) =>
          Promise.resolve(definition.handler(request, { signal }))
        );
        return { wallMs: (yield* Clock.currentTimeMillis) - startedAt };
      }
    ),
    { concurrency: "unbounded" }
  );
  return {
    elapsedMs: (yield* Clock.currentTimeMillis) - batchStartedAt,
    requests,
  } satisfies BatchMeasurement;
});

const average = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

const formatMs = (value: number): string => `${Math.round(value).toLocaleString()}ms`;

const pad = (value: string, width: number): string => value.padStart(width, " ");

const requestRows = (
  definition: BenchmarkDefinition,
  normal: BatchMeasurement,
  fluid: BatchMeasurement
): string =>
  normal.requests
    .map((normalRequest, index) => {
      const fluidRequest = fluid.requests[index];
      const benchmarkRequest = definition.requests[index];
      const fluidWallMs = fluidRequest?.wallMs ?? 0;
      const activeCpuMs = benchmarkRequest
        ? benchmarkRequest.workload.firstCpuMs + benchmarkRequest.workload.secondCpuMs
        : 0;
      const idleMs = Math.max(0, normalRequest.wallMs - activeCpuMs);
      const name = benchmarkRequest?.name ?? `request-${index + 1}`;
      return `  ${name.padEnd(22, " ")} ${pad(formatMs(normalRequest.wallMs), 10)}  ${pad(formatMs(activeCpuMs), 8)}  ${pad(formatMs(idleMs), 9)}  ${pad(formatMs(fluidWallMs), 10)}`;
    })
    .join("\n");

/** Renders the common conventional-versus-Fluid benchmark report. */
export const renderReport = (
  definition: BenchmarkDefinition,
  normal: BatchMeasurement,
  fluid: FluidMeasurement,
  fleet: {
    readonly slotsPerWorker: number;
    readonly maxWorkers: number;
    readonly spreadAtConcurrency: number;
  },
  environment: "Local idealized model" | "AWS Lambda measurement"
): string => {
  const normalHeading =
    environment === "AWS Lambda measurement"
      ? "NORMAL LAMBDA BASELINE (LOCAL MODEL)"
      : "NORMAL LAMBDA";
  const measurementNote =
    environment === "AWS Lambda measurement"
      ? "Worker intervals run from invocation launch through batch completion. Cold-start time is included; post-batch idle tail, pricing, memory weighting, and invocation charges are not."
      : "Worker intervals run from local worker launch through batch completion. Cloud startup, provider pricing, memory weighting, invocation charges, and idle tail are outside this idealized model.";
  const normalBilledMs = normal.requests.reduce(
    (total, request) => total + request.wallMs,
    0
  );
  const fluidBilledMs = fluid.totalWorkerIntervalMs;
  const activeCpuMs = definition.requests.reduce(
    (total, request) =>
      total + request.workload.firstCpuMs + request.workload.secondCpuMs,
    0
  );
  const savedRatio = 1 - fluidBilledMs / normalBilledMs;

  return `
LAMBDA FLUID BENCHMARK
${definition.name}
${definition.description}

SETUP
  Requests                 ${definition.requests.length} concurrent
  Endpoints                ${new Set(definition.requests.map((request) => request.request.path)).size}
  Slots per worker         ${fleet.slotsPerWorker}
  Maximum workers          ${fleet.maxWorkers}
  Spread threshold         ${fleet.spreadAtConcurrency} concurrent

PER-REQUEST BREAKDOWN
  route                    normal wall   CPU est.   I/O wait  fluid wall
${requestRows(definition, normal, fluid.batch)}

${normalHeading}
  Execution environments   ${definition.requests.length}
  Batch elapsed            ${formatMs(normal.elapsedMs)}
  Avg request wall         ${formatMs(average(normal.requests.map((request) => request.wallMs)))}
  Total billed duration    ${formatMs(normalBilledMs)}
  Billing rule             each request pays its own I/O wait

LAMBDA FLUID
  Worker invocations       ${fluid.workerInvocations}
  Peak in-flight / worker  ${fluid.peakInFlight}
  Batch elapsed            ${formatMs(fluid.batch.elapsedMs)}
  Avg request wall         ${formatMs(average(fluid.batch.requests.map((request) => request.wallMs)))}
  Total worker intervals   ${formatMs(fluidBilledMs)}
  Billing rule             each worker interval is shared by its logical requests

COMPARISON
  Batch-attributed duration avoided  ${formatMs(normalBilledMs - fluidBilledMs)}
  Batch-attributed reduction         ${(savedRatio * 100).toFixed(1)}%
  Active CPU estimate      ${formatMs(activeCpuMs)}
  Environment reduction    ${definition.requests.length} -> ${fluid.workerInvocations}

${environment}. ${measurementNote}
`;
};
