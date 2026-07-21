import { WorkerId } from "@lambda-fluid/protocol";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as S from "effect/Schema";

import { WorkerInvocation } from "./invocation.js";
import { WorkerInvocationError, WorkerInvoker } from "./worker-invoker.js";

export interface AwsWorkerLauncherOptions {
  readonly functionName: string;
  readonly tunnelUrl: URL;
  readonly admissionLimit: number;
  readonly awaitWorker: (workerId: WorkerId) => Effect.Effect<void>;
}

// oxfmt-ignore
export class WorkerExitedBeforeRegistration
  extends S.TaggedErrorClass<WorkerExitedBeforeRegistration>()(
    "AwsWorkerLauncher.WorkerExitedBeforeRegistration",
    { workerId: WorkerId },
  ) {}

/** Acquires a scoped launcher whose synchronous Lambda invocations are supervised. */
export const makeAwsWorkerLauncher = Effect.fn("AwsWorkerLauncher.make")(function* (
  options: AwsWorkerLauncherOptions
) {
  const workerInvoker = yield* WorkerInvoker;
  const invocations = yield* FiberSet.make<void, WorkerInvocationError>();

  return Effect.fn("AwsWorkerLauncher.launch")(function* (workerNumber: number) {
    const invocation = WorkerInvocation.cases.RunWorker.make({
      workerId: WorkerId.make(`aws-worker-${workerNumber}`),
      connectionGeneration: 1,
      tunnelUrl: options.tunnelUrl,
      admissionLimit: options.admissionLimit,
    });
    const payload = yield* S.encodeEffect(S.fromJsonString(WorkerInvocation))(
      invocation
    );
    const run = workerInvoker.invoke({
      functionName: options.functionName,
      payload: new TextEncoder().encode(payload),
    });

    const invocationFiber = yield* FiberSet.run(invocations, run);
    const exitedBeforeRegistration = Fiber.join(invocationFiber).pipe(
      Effect.andThen(
        Effect.fail(
          WorkerExitedBeforeRegistration.make({ workerId: invocation.workerId })
        )
      )
    );

    yield* Effect.raceFirst(
      options.awaitWorker(invocation.workerId),
      exitedBeforeRegistration
    );
  });
});
