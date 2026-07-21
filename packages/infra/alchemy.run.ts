import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "lambda-fluid",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const workerMain = yield* Config.string("LAMBDA_FLUID_WORKER_MAIN").pipe(
      Config.withDefault("./aws/lambda-worker.ts")
    );
    const worker = yield* AWS.Lambda.Function("WorkerLambda", {
      functionName: "lambda-fluid-worker",
      main: workerMain,
      handler: "handler",
      runtime: "nodejs22.x",
      architecture: "arm64",
      memorySize: 512,
      timeout: Duration.minutes(15),
      url: false,
    });

    return { worker };
  })
);
