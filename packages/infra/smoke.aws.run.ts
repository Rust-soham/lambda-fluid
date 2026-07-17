import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "lambda-fluid-smoke-aws",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const lambda = yield* AWS.Lambda.Function("SmokeLambda", {
      functionName: "lambda-fluid-smoke-aws",
      main: "./smoke/aws-lambda.ts",
      handler: "handler",
      runtime: "nodejs22.x",
      // Keep smoke invocation private and avoid Alchemy beta's implicit URL
      // default from causing unnecessary Lambda replacements.
      url: false,
    });

    return { lambda };
  }),
);
