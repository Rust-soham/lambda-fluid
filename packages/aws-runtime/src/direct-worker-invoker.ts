import * as AWS from "@distilled.cloud/aws";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { NodeHttpClient } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { WorkerInvocationError, WorkerInvoker } from "./worker-invoker.js";

const dependencies = Layer.mergeAll(
  AWS.Credentials.fromEnv(),
  AWS.Region.fromEnv(),
  NodeHttpClient.layerUndici
);

/** Direct AWS API adapter for callers that are not hosted by Alchemy. */
export const DirectAwsWorkerInvokerLive = Layer.effect(
  WorkerInvoker,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      AWS.Credentials.Credentials | AWS.Region.Region | HttpClient.HttpClient
    >();

    return WorkerInvoker.of({
      invoke: Effect.fn("DirectAwsWorkerInvoker.invoke")(function* (request) {
        yield* Lambda.invoke({
          FunctionName: request.functionName,
          InvocationType: "RequestResponse",
          Payload: request.payload,
        }).pipe(
          Effect.provide(context),
          Effect.mapError((cause) => WorkerInvocationError.make({ cause })),
          Effect.asVoid
        );
      }),
    });
  })
).pipe(Layer.provide(dependencies));
