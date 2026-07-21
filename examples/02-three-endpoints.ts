import { defineBenchmark } from "@lambda-fluid/benchmark";
import {
  ApplicationRequest,
  HttpStatusCode,
  SyntheticWorkload,
} from "@lambda-fluid/protocol";
import type { HandlerResponse, JobHandler } from "@lambda-fluid/worker";

const calculateFor = (durationMs: number): void => {
  const endsAt = performance.now() + durationMs;
  while (performance.now() < endsAt) {
    // Represents synchronous validation, pricing, or serialization work.
  }
};

const wait = (durationMs: number, signal: AbortSignal): Promise<void> =>
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

const jsonResponse = (value: object): HandlerResponse => ({
  statusCode: HttpStatusCode.make(200),
  headers: { "content-type": ["application/json"] },
  bodyChunks: [JSON.stringify(value)],
  delayBetweenChunksMs: 0,
});

const application: JobHandler = async (job, { signal }) => {
  const { method, path } = job.request;

  if (method === "POST" && path === "/orders") {
    calculateFor(5);
    await wait(200, signal);
    calculateFor(5);
    return jsonResponse({ orderId: crypto.randomUUID(), status: "reserved" });
  }

  if (method === "GET" && path === "/inventory/sku-123") {
    calculateFor(2);
    await wait(120, signal);
    calculateFor(2);
    return jsonResponse({ sku: "sku-123", available: 42 });
  }

  if (method === "GET" && path === "/recommendations/user-42") {
    calculateFor(8);
    await wait(300, signal);
    calculateFor(5);
    return jsonResponse({ userId: "user-42", products: ["sku-123", "sku-456"] });
  }

  return {
    statusCode: HttpStatusCode.make(404),
    headers: { "content-type": ["text/plain; charset=utf-8"] },
    bodyChunks: ["not found"],
    delayBetweenChunksMs: 0,
  };
};

const request = (
  name: string,
  method: "GET" | "POST",
  path: string,
  workload: SyntheticWorkload,
  body = ""
) => ({
  name,
  retrySafety: "RetrySafe" as const,
  request: ApplicationRequest.make({
    method,
    path,
    headers: body === "" ? {} : { "content-type": ["application/json"] },
    body,
  }),
  workload,
});

const orderWorkload = SyntheticWorkload.make({
  firstCpuMs: 5,
  ioDelayMs: 200,
  secondCpuMs: 5,
  responseChunks: 1,
  delayBetweenChunksMs: 0,
});

const inventoryWorkload = SyntheticWorkload.make({
  firstCpuMs: 2,
  ioDelayMs: 120,
  secondCpuMs: 2,
  responseChunks: 1,
  delayBetweenChunksMs: 0,
});

const recommendationWorkload = SyntheticWorkload.make({
  firstCpuMs: 8,
  ioDelayMs: 300,
  secondCpuMs: 5,
  responseChunks: 1,
  delayBetweenChunksMs: 0,
});

export default defineBenchmark({
  name: "Three-endpoint application",
  description: "Mixed orders, inventory, and recommendation traffic",
  handler: application,
  requests: Array.from({ length: 10 }, (_, index) => [
    request(
      `order-${index + 1}`,
      "POST",
      "/orders",
      orderWorkload,
      JSON.stringify({ sku: "sku-123", quantity: 1 })
    ),
    request(`inventory-${index + 1}`, "GET", "/inventory/sku-123", inventoryWorkload),
    request(
      `recommend-${index + 1}`,
      "GET",
      "/recommendations/user-42",
      recommendationWorkload
    ),
  ]).flat(),
});
