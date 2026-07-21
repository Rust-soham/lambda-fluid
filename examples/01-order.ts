import { defineBenchmark } from "@lambda-fluid/benchmark";
import {
  ApplicationRequest,
  HttpStatusCode,
  SyntheticWorkload,
} from "@lambda-fluid/protocol";

const workload = SyntheticWorkload.make({
  firstCpuMs: 5,
  ioDelayMs: 200,
  secondCpuMs: 5,
  responseChunks: 3,
  delayBetweenChunksMs: 10,
});

const waitForInventory = (
  durationMs: number,
  signal: AbortSignal
): Promise<{ readonly reservationId: string }> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => resolve({ reservationId: crypto.randomUUID() }),
      durationMs
    );
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true }
    );
  });

const calculateFor = (durationMs: number): void => {
  const endsAt = performance.now() + durationMs;
  while (performance.now() < endsAt) {
    // Represents synchronous validation, pricing, or serialization work.
  }
};

export default defineBenchmark({
  name: "Order inventory lookup",
  description: "One route: CPU -> inventory wait -> CPU -> streamed receipt",
  requests: Array.from({ length: 30 }, (_, index) => ({
    name: `order-${index + 1}`,
    retrySafety: "RetrySafe" as const,
    request: ApplicationRequest.make({
      method: "POST",
      path: "/orders",
      headers: { "content-type": ["application/json"] },
      body: JSON.stringify({ sku: "sku-123", quantity: 1 }),
    }),
    workload,
  })),
  handler: async (job, { signal }) => {
    if (job.request.method !== "POST" || job.request.path !== "/orders") {
      return {
        statusCode: HttpStatusCode.make(404),
        headers: { "content-type": ["text/plain; charset=utf-8"] },
        bodyChunks: ["not found"],
        delayBetweenChunksMs: 0,
      };
    }

    calculateFor(workload.firstCpuMs);
    const inventory = await waitForInventory(workload.ioDelayMs, signal);
    calculateFor(workload.secondCpuMs);

    const receipt = JSON.stringify({
      reservationId: inventory.reservationId,
      available: true,
    });
    const chunkSize = Math.ceil(receipt.length / workload.responseChunks);

    return {
      statusCode: HttpStatusCode.make(200),
      headers: { "content-type": ["application/json"] },
      bodyChunks: Array.from({ length: workload.responseChunks }, (_, chunk) =>
        receipt.slice(chunk * chunkSize, (chunk + 1) * chunkSize)
      ),
      delayBetweenChunksMs: workload.delayBetweenChunksMs,
    };
  },
});
