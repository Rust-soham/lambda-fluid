import { HttpStatusCode, SyntheticWorkload } from "@lambda-fluid/protocol";
import type { JobHandler } from "@lambda-fluid/worker";
import * as S from "effect/Schema";

export class InventoryRequest extends S.Class<InventoryRequest>("InventoryRequest")({
  requestId: S.NonEmptyString,
  quantity: S.Int.pipe(S.check(S.isGreaterThan(0))),
  delayMs: S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(0))),
}) {}

export class InventoryReservation extends S.Class<InventoryReservation>(
  "InventoryReservation"
)({
  reservationId: S.NonEmptyString,
  available: S.Boolean,
}) {}

export class OrderReceipt extends S.Class<OrderReceipt>("OrderReceipt")({
  reservationId: S.NonEmptyString,
  available: S.Boolean,
}) {}

export type OrderPhase =
  | "CpuStarted"
  | "InventoryFetchStarted"
  | "InventoryFetchCompleted"
  | "CpuResumed"
  | "HandlerCompleted";

export interface OrderEvent {
  readonly requestId: string;
  readonly phase: OrderPhase;
  readonly atEpochMs: number;
}

export interface OrderHandlerOptions {
  readonly inventoryUrl: string;
  readonly onEvent?: (event: OrderEvent) => void;
}

const burnCpu = (durationMs: number): void => {
  const endsAt = performance.now() + durationMs;
  while (performance.now() < endsAt) {
    // Deliberately occupies the shared JavaScript thread for the benchmark.
  }
};

const splitBody = (body: string, chunkCount: number): ReadonlyArray<string> => {
  const size = Math.ceil(body.length / chunkCount);
  return Array.from({ length: chunkCount }, (_, index) =>
    body.slice(index * size, (index + 1) * size)
  );
};

/** A normal Promise handler that performs CPU -> real HTTP I/O -> CPU. */
export const makeOrderHandler =
  (options: OrderHandlerOptions): JobHandler =>
  async (request, { signal }) => {
    const workload = await S.decodeUnknownPromise(SyntheticWorkload)(
      JSON.parse(request.request.body)
    );
    const emit = (phase: OrderPhase): void =>
      options.onEvent?.({
        requestId: request.requestId,
        phase,
        atEpochMs: Date.now(),
      });

    emit("CpuStarted");
    burnCpu(workload.firstCpuMs);

    emit("InventoryFetchStarted");
    const response = await fetch(options.inventoryUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        InventoryRequest.make({
          requestId: request.requestId,
          quantity: 1,
          delayMs: workload.ioDelayMs,
        })
      ),
      signal,
    });
    if (!response.ok) {
      throw new Error(`inventory request failed with status ${response.status}`);
    }
    const reservation = await response
      .json()
      .then(S.decodeUnknownPromise(InventoryReservation));
    emit("InventoryFetchCompleted");

    emit("CpuResumed");
    burnCpu(workload.secondCpuMs);
    const receipt = JSON.stringify(
      OrderReceipt.make({
        reservationId: reservation.reservationId,
        available: reservation.available,
      })
    );
    emit("HandlerCompleted");

    return {
      statusCode: HttpStatusCode.make(200),
      headers: { "content-type": ["application/json"] },
      bodyChunks: splitBody(receipt, workload.responseChunks),
      delayBetweenChunksMs: workload.delayBetweenChunksMs,
    };
  };
