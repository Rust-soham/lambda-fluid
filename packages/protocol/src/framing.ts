import * as Result from "effect/Result";
import * as S from "effect/Schema";

export const defaultMaxFrameBytes = 1024 * 1024;

export interface FrameDecoderState {
  readonly buffered: Uint8Array;
}

export interface DecodedFrames {
  readonly state: FrameDecoderState;
  readonly payloads: ReadonlyArray<Uint8Array>;
}

export const FrameFailureReason = S.Literals(["EmptyFrame", "FrameTooLarge"]);
export type FrameFailureReason = typeof FrameFailureReason.Type;

// oxfmt-ignore
export class FrameCodecError
  extends S.TaggedErrorClass<FrameCodecError>()("Protocol.FrameCodecError", {
    reason: FrameFailureReason,
}) {}

export const emptyFrameDecoderState = (): FrameDecoderState => ({
  buffered: new Uint8Array(),
});

const concatenate = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
};

const readLength = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] * 0x1000000 +
  bytes[offset + 1] * 0x10000 +
  bytes[offset + 2] * 0x100 +
  bytes[offset + 3];

// Consumes arbitrary TCP chunks while retaining only the incomplete trailing frame.
export const decodeFrameChunk = (
  state: FrameDecoderState,
  chunk: Uint8Array,
  maxFrameBytes = defaultMaxFrameBytes
): Result.Result<DecodedFrames, FrameCodecError> => {
  const bytes = concatenate(state.buffered, chunk);
  const payloads: Array<Uint8Array> = [];
  let offset = 0;

  while (bytes.length - offset >= 4) {
    const payloadLength = readLength(bytes, offset);
    if (payloadLength === 0) {
      return Result.fail(FrameCodecError.make({ reason: "EmptyFrame" }));
    }
    if (payloadLength > maxFrameBytes) {
      return Result.fail(FrameCodecError.make({ reason: "FrameTooLarge" }));
    }
    if (bytes.length - offset - 4 < payloadLength) {
      break;
    }

    const payloadStart = offset + 4;
    payloads.push(bytes.slice(payloadStart, payloadStart + payloadLength));
    offset = payloadStart + payloadLength;
  }

  return Result.succeed({
    state: { buffered: bytes.slice(offset) },
    payloads,
  });
};

export const encodeFrame = (
  payload: Uint8Array,
  maxFrameBytes = defaultMaxFrameBytes
): Result.Result<Uint8Array, FrameCodecError> => {
  if (payload.length === 0) {
    return Result.fail(FrameCodecError.make({ reason: "EmptyFrame" }));
  }
  if (payload.length > maxFrameBytes) {
    return Result.fail(FrameCodecError.make({ reason: "FrameTooLarge" }));
  }

  const framed = new Uint8Array(4 + payload.length);
  const length = payload.length;
  framed[0] = (length >>> 24) & 0xff;
  framed[1] = (length >>> 16) & 0xff;
  framed[2] = (length >>> 8) & 0xff;
  framed[3] = length & 0xff;
  framed.set(payload, 4);
  return Result.succeed(framed);
};
