import { Data, Effect, Schema } from "effect";

Effect.runFork(Effect.logInfo("hoe hoe"));

export class InvalidSession extends Data.TaggedError("InvalidSession")<{
  token: string;
  reason: "expired" | "missing" | "revoked";
}> {}

export class MissingApiKey extends Data.TaggedError("MissingApiKey")<{
  key: string;
  source: "env" | "config" | "secret";
  message: string;
}> {}

export class FuckOff extends Data.TaggedError("FuckOff")<{
  cause: Schema.String;
}> {}
