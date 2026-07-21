import { NodeServices } from "@effect/platform-node";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import { Resolver } from "node:dns/promises";

const quickTunnelUrl = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// oxfmt-ignore
export class QuickTunnelStartError
  extends S.TaggedErrorClass<QuickTunnelStartError>()("QuickTunnelStartError", {
    reason: S.Literals([
      "ExitedBeforeReady",
      "UrlTimedOut",
      "ConnectionTimedOut",
      "DnsTimedOut",
    ]),
  }) {}

export interface QuickTunnel {
  readonly publicUrl: URL;
}

/** Starts a development-only Cloudflare Quick Tunnel and closes it with the scope. */
export const makeQuickTunnel = Effect.fn("QuickTunnel.make")(function* (
  localUrl: URL,
  executable = "cloudflared"
) {
  const ready = yield* Deferred.make<URL, QuickTunnelStartError>();
  const connected = yield* Deferred.make<void, QuickTunnelStartError>();
  const process = yield* ChildProcess.make(executable, [
    "tunnel",
    "--url",
    localUrl.toString(),
    "--no-autoupdate",
  ]);

  const observeOutput = process.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const match = quickTunnelUrl.exec(line);
      return Effect.all(
        [
          match === null
            ? Effect.void
            : Deferred.succeed(ready, new URL(match[0])).pipe(Effect.asVoid),
          line.includes("Registered tunnel connection")
            ? Deferred.succeed(connected, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ],
        { discard: true }
      );
    })
  );
  yield* Effect.forkScoped(observeOutput);

  const exited = process.exitCode.pipe(
    Effect.flatMap(() =>
      Deferred.fail(ready, QuickTunnelStartError.make({ reason: "ExitedBeforeReady" }))
    ),
    Effect.forkScoped
  );
  yield* exited;

  const publicUrl = yield* Deferred.await(ready).pipe(
    Effect.timeoutOption("30 seconds"),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(QuickTunnelStartError.make({ reason: "UrlTimedOut" })),
        onSome: Effect.succeed,
      })
    )
  );
  yield* Deferred.await(connected).pipe(
    Effect.timeoutOption("30 seconds"),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(QuickTunnelStartError.make({ reason: "ConnectionTimedOut" })),
        onSome: Effect.succeed,
      })
    )
  );

  // Query Cloudflare directly so an early OS-level NXDOMAIN is not cached locally.
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1"]);
  yield* Effect.tryPromise({
    try: () => resolver.resolve4(publicUrl.hostname),
    catch: () => QuickTunnelStartError.make({ reason: "DnsTimedOut" }),
  }).pipe(
    Effect.retry(Schedule.max([Schedule.exponential("100 millis"), Schedule.recurs(8)]))
  );

  return { publicUrl } satisfies QuickTunnel;
});

export const QuickTunnelProcessLive = NodeServices.layer;
