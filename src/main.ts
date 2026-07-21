import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class UserNotFound extends Data.TaggedError("UserNotFound")<{
  cause: Schema.String;
}> {}

export class InvalidSession extends Data.TaggedError("InvalidSession")<{
  token: string;
  reason: "expired" | "missing" | "revoked";
}> {}

const program = Console.log("hi");

const program2 = Console.log("bye");

Effect.runFork(Effect.all([program, program2]));
