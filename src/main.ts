import { Console, Data, Effect, Schema } from "effect";

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
