import { assert, describe, it } from "@effect/vitest";
import { encodeFrame } from "@lambda-fluid/protocol";
import * as Channel from "effect/Channel";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { decodeByteChannel } from "../src/channel.js";

const encoder = new TextEncoder();

const frame = (text: string): Uint8Array => {
  const encoded = encodeFrame(encoder.encode(text));
  if (Result.isFailure(encoded)) assert.fail(encoded.failure.reason);
  return encoded.success;
};

describe("framed byte channel", () => {
  it.effect("retains state across pulls and emits every complete payload", () =>
    Effect.gen(function* () {
      const first = frame("one");
      const second = frame("two");
      const combined = new Uint8Array(first.length + second.length);
      combined.set(first);
      combined.set(second, first.length);

      const chunks = [
        combined.slice(0, 2),
        combined.slice(2, first.length + 3),
        combined.slice(first.length + 3),
      ];

      const decoded = yield* Channel.fromIterable(chunks).pipe(
        decodeByteChannel,
        Channel.runCollect
      );

      assert.deepEqual(decoded, [encoder.encode("one"), encoder.encode("two")]);
    })
  );
});
