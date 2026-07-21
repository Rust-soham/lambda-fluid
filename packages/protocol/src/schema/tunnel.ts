import * as S from "effect/Schema";

import { BeginDrain, CancelJob, JobRequest, RegistrationAccepted } from "./job.js";
import {
  ResponseBodyChunk,
  ResponseEnd,
  ResponseFailed,
  ResponseStarted,
} from "./response.js";
import {
  JobAccepted,
  JobNack,
  WorkerDraining,
  WorkerHealthSnapshot,
  WorkerRegistration,
} from "./worker.js";

export const OrchestratorToWorkerFrame = S.Union([
  RegistrationAccepted,
  JobRequest,
  CancelJob,
  BeginDrain,
]).pipe(S.toTaggedUnion("_tag"));
export type OrchestratorToWorkerFrame = typeof OrchestratorToWorkerFrame.Type;

export const WorkerToOrchestratorFrame = S.Union([
  WorkerRegistration,
  WorkerHealthSnapshot,
  JobAccepted,
  JobNack,
  ResponseStarted,
  ResponseBodyChunk,
  ResponseEnd,
  ResponseFailed,
  WorkerDraining,
]).pipe(S.toTaggedUnion("_tag"));
export type WorkerToOrchestratorFrame = typeof WorkerToOrchestratorFrame.Type;

export const TunnelFrame = S.Union([
  OrchestratorToWorkerFrame,
  WorkerToOrchestratorFrame,
]).pipe(S.toTaggedUnion("_tag"));
export type TunnelFrame = typeof TunnelFrame.Type;
