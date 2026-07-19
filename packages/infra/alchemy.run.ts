import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "lambda-fluid",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.succeed({})
);
