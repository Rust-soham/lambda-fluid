import { isBenchmarkDefinition } from "@lambda-fluid/benchmark";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";

// oxfmt-ignore
export class BenchmarkDefinitionError
  extends S.TaggedErrorClass<BenchmarkDefinitionError>()(
    "BenchmarkDefinitionError",
    { message: S.String },
  ) {}

/** Loads a trusted TypeScript benchmark definition through Vite's SSR loader. */
export const loadDefinition = Effect.fn("Bench.loadDefinition")(function* (
  examplePath: string
) {
  const vite = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createViteServer({
          appType: "custom",
          logLevel: "silent",
          server: { middlewareMode: true },
        }),
      catch: (cause) =>
        BenchmarkDefinitionError.make({
          message: `could not start the TypeScript loader: ${String(cause)}`,
        }),
    }),
    (server) => Effect.promise(() => server.close())
  );
  const loaded: unknown = yield* Effect.tryPromise({
    try: () => vite.ssrLoadModule(resolve(examplePath)),
    catch: (cause) =>
      BenchmarkDefinitionError.make({
        message: `could not load ${examplePath}: ${String(cause)}`,
      }),
  });
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("default" in loaded) ||
    !isBenchmarkDefinition(loaded.default)
  ) {
    return yield* Effect.fail(
      BenchmarkDefinitionError.make({
        message: `${examplePath} must default-export defineBenchmark({...})`,
      })
    );
  }
  return loaded.default;
});
