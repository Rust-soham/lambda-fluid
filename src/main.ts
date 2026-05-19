import { Console, Data, Effect, Schema } from "effect";



export class UserNotFound 
    extends Data.TaggedError("UserNotFound")<{
        cause: Schema.String,
}> {}

const program = Console.log("hi");

const program2 = Console.log("bye");


Effect.all([program, program2]).pipe(Effect.runPromise);
