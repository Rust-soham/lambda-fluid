import {
  decodeFrameChunk,
  decodeOrchestratorPayload,
  decodeWorkerPayload,
  emptyFrameDecoderState,
  encodeOrchestratorFrame,
  encodeWorkerFrame,
  type FrameCodecError,
  type FrameDecoderState,
  type OrchestratorToWorkerFrame,
  type WorkerToOrchestratorFrame,
} from "@lambda-fluid/protocol";
import type { NonEmptyReadonlyArray } from "effect/Array";
import * as Channel from "effect/Channel";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as Socket from "effect/unstable/socket/Socket";

// Turns arbitrary socket chunks into complete payloads while retaining partial frames.
export const decodeByteChannel = <OutErr, OutDone, InElem, InErr, InDone, Env>(
  source: Channel.Channel<Uint8Array, OutErr, OutDone, InElem, InErr, InDone, Env>
): Channel.Channel<
  Uint8Array,
  OutErr | FrameCodecError,
  OutDone,
  InElem,
  InErr,
  InDone,
  Env
> =>
  source.pipe(
    Channel.mapAccum(
      emptyFrameDecoderState,
      (state: FrameDecoderState, chunk: Uint8Array) =>
        Effect.fromResult(decodeFrameChunk(state, chunk)).pipe(
          Effect.map((decoded) => [decoded.state, decoded.payloads] as const)
        )
    )
  );

const socketPayloadChannel = <InputError>(socket: Socket.Socket) =>
  Socket.toChannel<InputError>(socket).pipe(Channel.flattenArray, decodeByteChannel);

type OrchestratorOutboundError = Schema.SchemaError | FrameCodecError;
type WorkerOutboundError = Schema.SchemaError | FrameCodecError;

const encodeOrchestratorBatch = (
  frames: NonEmptyReadonlyArray<OrchestratorToWorkerFrame>
): Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, OrchestratorOutboundError> =>
  Effect.gen(function* () {
    const head = yield* encodeOrchestratorFrame(frames[0]);
    const tail = yield* Effect.forEach(frames.slice(1), encodeOrchestratorFrame);
    return [head, ...tail];
  });

const encodeWorkerBatch = (
  frames: NonEmptyReadonlyArray<WorkerToOrchestratorFrame>
): Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, WorkerOutboundError> =>
  Effect.gen(function* () {
    const head = yield* encodeWorkerFrame(frames[0]);
    const tail = yield* Effect.forEach(frames.slice(1), encodeWorkerFrame);
    return [head, ...tail];
  });

// The orchestrator reads worker frames and writes orchestrator frames on one socket.
export const orchestratorTunnelChannel = (socket: Socket.Socket) =>
  socketPayloadChannel<OrchestratorOutboundError>(socket).pipe(
    Channel.mapEffect(decodeWorkerPayload),
    Channel.map((frame) => [frame] as const),
    Channel.mapInput(encodeOrchestratorBatch)
  );

// The worker reads orchestrator frames and writes worker frames on one socket.
export const workerTunnelChannel = (socket: Socket.Socket) =>
  socketPayloadChannel<WorkerOutboundError>(socket).pipe(
    Channel.mapEffect(decodeOrchestratorPayload),
    Channel.map((frame) => [frame] as const),
    Channel.mapInput(encodeWorkerBatch)
  );
