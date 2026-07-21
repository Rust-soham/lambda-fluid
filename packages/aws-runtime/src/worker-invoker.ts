import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as S from "effect/Schema";

export interface WorkerInvokeRequest {
  readonly functionName: string;
  readonly payload: Uint8Array;
}

// oxfmt-ignore
export class WorkerInvocationError
  extends S.TaggedErrorClass<WorkerInvocationError>()(
    "WorkerInvoker.WorkerInvocationError",
    { cause: S.Defect() },
  ) {}

/** Runtime capability for keeping one outer worker invocation alive. */
export class WorkerInvoker extends Context.Service<
  WorkerInvoker,
  {
    readonly invoke: (
      request: WorkerInvokeRequest
    ) => Effect.Effect<void, WorkerInvocationError>;
  }
>()("@lambda-fluid/aws-runtime/WorkerInvoker") {}
