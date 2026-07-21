import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { makeAdaptiveCapacity } from "../src/adaptive-capacity.js";

describe("adaptive fleet capacity", () => {
  it.effect("atomically scales a burst and switches between Spread and Pack", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const launches = yield* Ref.make<ReadonlyArray<number>>([]);
        const capacity = yield* makeAdaptiveCapacity({
          slotsPerWorker: 8,
          maxWorkers: 4,
          spreadAtConcurrency: 9,
          packBelowConcurrency: 4,
          launch: (workerNumber) =>
            Ref.update(launches, (current) => [...current, workerNumber]),
        });

        const leases = yield* Effect.forEach(
          Array.from({ length: 30 }),
          () => capacity.acquire(),
          { concurrency: "unbounded" }
        );
        const busy = yield* capacity.snapshot;

        assert.deepEqual(yield* Ref.get(launches), [1, 2, 3, 4]);
        assert.strictEqual(busy.readyWorkers, 4);
        assert.strictEqual(busy.peakWorkers, 4);
        assert.strictEqual(busy.activeRequests, 30);
        assert.strictEqual(busy.mode, "Spread");
        assert.isTrue(leases.some((lease) => lease.policy._tag === "Spread"));

        yield* Effect.forEach(leases, (lease) => lease.release, {
          concurrency: "unbounded",
          discard: true,
        });
        const idle = yield* capacity.snapshot;
        assert.strictEqual(idle.activeRequests, 0);
        assert.strictEqual(idle.mode, "Pack");
      })
    )
  );
});
