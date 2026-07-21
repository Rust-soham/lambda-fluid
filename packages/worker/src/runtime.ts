import {
  JobNack,
  ResponseFailed,
  type AttemptId,
  type JobRequest,
  type RequestId,
  type WorkerId,
  type WorkerToOrchestratorFrame,
} from "@lambda-fluid/protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import { makeJobHandler, type JobHandler } from "./job-handler.js";
import {
  AdmissionDecision,
  WorkerAdmission,
  admit,
  finish,
  type WorkerState,
} from "./worker-state.js";

export interface WorkerRuntime {
  readonly frames: Stream.Stream<WorkerToOrchestratorFrame>;
  readonly submit: (request: JobRequest) => Effect.Effect<void>;
  readonly cancel: (
    requestId: RequestId,
    attemptId: AttemptId,
    cancelledAtEpochMs: number
  ) => Effect.Effect<void>;
  readonly beginDrain: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<WorkerState>;
}

export interface WorkerRuntimeOptions {
  readonly workerId: WorkerId;
  readonly connectionGeneration: number;
  readonly admissionLimit: number;
  readonly outboundCapacity: number;
  readonly handler: JobHandler;
}

/** Acquires all worker-owned state and fibers inside the caller's scope. */
export const makeWorkerRuntime = (
  options: WorkerRuntimeOptions
): Effect.Effect<WorkerRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* TxRef.make<WorkerState>({
      admission: WorkerAdmission.Accepting({ limit: options.admissionLimit }),
      activeAttempts: new Map(),
      inFlightHighWater: 0,
    });
    const jobs = yield* FiberMap.make<RequestId>();
    const outbound = yield* Queue.bounded<WorkerToOrchestratorFrame>(
      options.outboundCapacity
    );

    const emit = Effect.fn("Worker.emit")((frame: WorkerToOrchestratorFrame) =>
      Queue.offer(outbound, frame).pipe(Effect.asVoid)
    );
    const complete = Effect.fn("Worker.complete")((request: JobRequest) =>
      Effect.tx(
        TxRef.update(state, (current) =>
          finish(current, request.requestId, request.attemptId)
        )
      )
    );
    const handleJob = makeJobHandler({
      workerId: options.workerId,
      connectionGeneration: options.connectionGeneration,
      handler: options.handler,
      emit,
      complete,
    });

    const submit = Effect.fn("Worker.submit")(function* (request: JobRequest) {
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const decision = yield* Effect.tx(
            TxRef.modify(state, (current) => admit(current, request))
          );

          if (AdmissionDecision.$is("Rejected")(decision)) {
            yield* emit(
              JobNack.make({
                requestId: request.requestId,
                attemptId: request.attemptId,
                workerId: options.workerId,
                connectionGeneration: options.connectionGeneration,
                reason: decision.reason,
                nackedAtEpochMs: yield* Clock.currentTimeMillis,
              })
            );
            return;
          }

          yield* FiberMap.run(jobs, request.requestId, restore(handleJob(request)), {
            onlyIfMissing: true,
          });
        })
      );
    });

    const cancel = Effect.fn("Worker.cancel")(function* (
      requestId: RequestId,
      attemptId: AttemptId,
      cancelledAtEpochMs: number
    ) {
      const isCurrentAttempt = yield* Effect.tx(
        TxRef.get(state).pipe(
          Effect.map((current) => current.activeAttempts.get(requestId) === attemptId)
        )
      );
      if (!isCurrentAttempt) return;

      yield* FiberMap.remove(jobs, requestId);
      yield* emit(
        ResponseFailed.make({
          requestId,
          attemptId,
          failedAtEpochMs: cancelledAtEpochMs,
          reason: "Cancelled",
        })
      );
    });

    return {
      frames: Stream.fromQueue(outbound),
      submit,
      cancel,
      beginDrain: Effect.tx(
        TxRef.update(state, (current) => ({
          ...current,
          admission: WorkerAdmission.Draining(),
        }))
      ),
      snapshot: Effect.tx(TxRef.get(state)),
    };
  });
