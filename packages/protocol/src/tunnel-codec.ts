import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

import { encodeFrame, type FrameCodecError } from "./framing.js";
import {
  OrchestratorToWorkerFrame,
  WorkerToOrchestratorFrame,
  type OrchestratorToWorkerFrame as OrchestratorFrame,
  type WorkerToOrchestratorFrame as WorkerFrame,
} from "./schema/tunnel.js";

const OrchestratorFrameJson = S.fromJsonString(
  S.toCodecJson(OrchestratorToWorkerFrame)
);
const WorkerFrameJson = S.fromJsonString(S.toCodecJson(WorkerToOrchestratorFrame));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const Utf8FailureReason = S.Literal("InvalidUtf8");

// oxfmt-ignore
export class TunnelCodecError
  extends S.TaggedErrorClass<TunnelCodecError>()("Protocol.TunnelCodecError", {
    reason: Utf8FailureReason,
}) {}

const decodeText = (payload: Uint8Array): Effect.Effect<string, TunnelCodecError> =>
  Effect.try({
    try: () => textDecoder.decode(payload),
    catch: () => TunnelCodecError.make({ reason: "InvalidUtf8" }),
  });

const frameEncodedText = (
  encoded: string
): Effect.Effect<Uint8Array, FrameCodecError> =>
  Effect.fromResult(encodeFrame(textEncoder.encode(encoded)));

export const encodeOrchestratorFrame = (
  frame: OrchestratorFrame
): Effect.Effect<Uint8Array, S.SchemaError | FrameCodecError> =>
  S.encodeEffect(OrchestratorFrameJson)(frame).pipe(Effect.flatMap(frameEncodedText));

export const decodeOrchestratorPayload = (
  payload: Uint8Array
): Effect.Effect<OrchestratorFrame, S.SchemaError | TunnelCodecError> =>
  decodeText(payload).pipe(Effect.flatMap(S.decodeEffect(OrchestratorFrameJson)));

export const encodeWorkerFrame = (
  frame: WorkerFrame
): Effect.Effect<Uint8Array, S.SchemaError | FrameCodecError> =>
  S.encodeEffect(WorkerFrameJson)(frame).pipe(Effect.flatMap(frameEncodedText));

export const decodeWorkerPayload = (
  payload: Uint8Array
): Effect.Effect<WorkerFrame, S.SchemaError | TunnelCodecError> =>
  decodeText(payload).pipe(Effect.flatMap(S.decodeEffect(WorkerFrameJson)));
