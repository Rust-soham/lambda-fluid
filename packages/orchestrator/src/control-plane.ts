import {
  RegistrationAccepted,
  type JobRequest,
  type OrchestratorToWorkerFrame,
  type ResponseFrame,
  type WorkerRegistration,
  type WorkerToOrchestratorFrame,
} from "@lambda-fluid/protocol";
import { orchestratorTunnelChannel } from "@lambda-fluid/tunnel";
import * as Channel from "effect/Channel";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { Success } from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";
import type * as Socket from "effect/unstable/socket/Socket";

import { makeFleetRegistry, type FleetRegistryError } from "./fleet-registry.js";
import type { RoutingPolicy } from "./fleet-state.js";
import { makeWorkerState } from "./worker-state.js";

interface WorkerConnection {
  readonly registration: WorkerRegistration;
  readonly outbound: Queue.Queue<OrchestratorToWorkerFrame>;
}

export interface OrchestratorControlPlaneOptions {
  /** Benchmark-only seed; omit it to preserve conservative production learning. */
  readonly initialAdmissionLimit?: number;
}

export const DispatchFailure = S.Literals([
  "ConnectionMissing",
  "ProtocolViolation",
  "WorkerNacked",
  "WorkerResponseFailed",
]);
export type DispatchFailure = typeof DispatchFailure.Type;

// oxfmt-ignore
export class DispatchError
  extends S.TaggedErrorClass<DispatchError>()("Orchestrator.DispatchError", {
    reason: DispatchFailure,
  }) {}

const isResponseFrame = (frame: WorkerToOrchestratorFrame): frame is ResponseFrame =>
  frame._tag === "ResponseStarted" ||
  frame._tag === "ResponseBodyChunk" ||
  frame._tag === "ResponseEnd" ||
  frame._tag === "ResponseFailed";

const isSomeResponse = (
  response: Option.Option<ResponseFrame>
): response is Option.Some<ResponseFrame> => Option.isSome(response);

/** Acquires the connection directory and broadcast buses for the orchestrator. */
export const makeOrchestratorControlPlane = (
  options: OrchestratorControlPlaneOptions = {}
) =>
  Effect.gen(function* () {
    const fleet = yield* makeFleetRegistry();
    const connections = yield* TxRef.make<ReadonlyMap<string, WorkerConnection>>(
      new Map()
    );
    const workerFrames = yield* PubSub.unbounded<WorkerToOrchestratorFrame>();
    const registrations = yield* PubSub.unbounded<WorkerRegistration>({ replay: 1 });

    const runWorkerSession = Effect.fn("Orchestrator.runWorkerSession")(function* (
      socket: Socket.Socket
    ) {
      const outbound = yield* Queue.unbounded<OrchestratorToWorkerFrame>();
      const registrationRef = yield* Ref.make<Option.Option<WorkerRegistration>>(
        Option.none()
      );
      const initialized = yield* Ref.make(false);

      const handle = Effect.fn("Orchestrator.handleWorkerFrame")(function* (
        frame: WorkerToOrchestratorFrame
      ) {
        if (frame._tag === "WorkerRegistration") {
          yield* Ref.set(registrationRef, Option.some(frame));
          yield* Effect.tx(
            TxRef.update(connections, (current) => {
              const next = new Map(current);
              next.set(frame.workerId, { registration: frame, outbound });
              return next;
            })
          );
          yield* Queue.offer(
            outbound,
            RegistrationAccepted.make({
              workerId: frame.workerId,
              connectionGeneration: frame.connectionGeneration,
              acceptedAtEpochMs: yield* Clock.currentTimeMillis,
            })
          );
          return;
        }

        if (frame._tag === "WorkerHealthSnapshot") {
          const registration = yield* Ref.get(registrationRef);
          if (Option.isNone(registration)) return;

          const isInitialized = yield* Ref.get(initialized);
          if (isInitialized) {
            yield* fleet.applySnapshot(frame);
          } else {
            const worker = yield* Effect.fromResult(
              makeWorkerState(registration.value, frame, {
                initialAdmissionLimit: options.initialAdmissionLimit,
              })
            );
            yield* fleet.addWorker(worker);
            yield* Ref.set(initialized, true);
            // Readiness means both identity and initial capacity are committed.
            yield* PubSub.publish(registrations, registration.value);
          }
          return;
        }

        yield* PubSub.publish(workerFrames, frame);
      });

      yield* Stream.fromQueue(outbound).pipe(
        Stream.pipeThroughChannel(orchestratorTunnelChannel(socket)),
        Stream.runForEach(handle),
        Effect.ensuring(
          Ref.get(registrationRef).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (registration) =>
                  Effect.all(
                    [
                      fleet.removeWorker(
                        registration.workerId,
                        registration.connectionGeneration
                      ),
                      Effect.tx(
                        TxRef.update(connections, (current) => {
                          const existing = current.get(registration.workerId);
                          if (
                            existing?.registration.connectionGeneration !==
                            registration.connectionGeneration
                          ) {
                            return current;
                          }
                          const next = new Map(current);
                          next.delete(registration.workerId);
                          return next;
                        })
                      ),
                    ],
                    { discard: true }
                  ),
              })
            )
          )
        )
      );
    });

    const responses = (
      request: JobRequest,
      policy: RoutingPolicy
    ): Stream.Stream<ResponseFrame, DispatchError | FleetRegistryError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before dispatch so an immediate acknowledgement cannot be lost.
          const subscription = yield* PubSub.subscribe(workerFrames);
          const selection = yield* fleet.selectAndReserve(
            request.requestId,
            request.attemptId,
            yield* Clock.currentTimeMillis,
            policy
          );
          const connection = yield* Effect.tx(
            TxRef.get(connections).pipe(
              Effect.map((current) => current.get(selection.workerId))
            )
          );
          if (
            connection === undefined ||
            connection.registration.connectionGeneration !==
              selection.connectionGeneration
          ) {
            return yield* Effect.fail(
              DispatchError.make({ reason: "ConnectionMissing" })
            );
          }

          yield* Queue.offer(connection.outbound, request);

          const processFrame = (
            frame: WorkerToOrchestratorFrame
          ): Effect.Effect<
            Option.Option<ResponseFrame>,
            DispatchError | FleetRegistryError
          > => {
            if (frame._tag === "JobAccepted") {
              return fleet.accept(frame).pipe(Effect.as(Option.none<ResponseFrame>()));
            }
            if (frame._tag === "JobNack") {
              return fleet
                .applyNack(frame)
                .pipe(
                  Effect.flatMap(() =>
                    Effect.fail(DispatchError.make({ reason: "WorkerNacked" }))
                  )
                );
            }
            if (isResponseFrame(frame)) {
              if (frame._tag === "ResponseEnd" || frame._tag === "ResponseFailed") {
                return fleet
                  .release(
                    selection.workerId,
                    selection.connectionGeneration,
                    request.requestId,
                    request.attemptId
                  )
                  .pipe(Effect.as(Option.some(frame)));
              }
              return Effect.succeed(Option.some(frame));
            }
            return Effect.succeed(Option.none<ResponseFrame>());
          };

          return Stream.fromChannel(Channel.fromSubscriptionArray(subscription)).pipe(
            Stream.filter(
              (frame) =>
                "requestId" in frame &&
                frame.requestId === request.requestId &&
                "attemptId" in frame &&
                frame.attemptId === request.attemptId
            ),
            Stream.mapEffect(processFrame),
            Stream.filter(isSomeResponse),
            Stream.map((frame) => frame.value),
            Stream.takeUntil(
              (frame) => frame._tag === "ResponseEnd" || frame._tag === "ResponseFailed"
            )
          );
        })
      );

    return {
      fleet,
      awaitWorker: fleet.awaitWorker,
      workerRegistrations: Stream.fromPubSub(registrations),
      runWorkerSession,
      responses,
    };
  });

export interface OrchestratorControlPlane extends Success<
  ReturnType<typeof makeOrchestratorControlPlane>
> {}
