# how different is the custom tcp port that vercel made for fluid compute to orchestrate different lambdas and charge for active cpu time only

This is one of the most clever infrastructure hacks of the last few years and the TCP protocol design at its core is genuinely interesting.

---

## The Core Problem They Were Solving

AWS Lambda's execution model is a **request-in, response-out black box** — you get an event object, you return a response object, done. There's no concept of streaming, no long-lived connection back to AWS infrastructure, and billing is pure wall-clock time (duration × memory), so you pay the same rate whether your code is burning CPU or just `await`-ing a database response. For AI workloads where 90% of time is waiting on an LLM, this is catastrophically wasteful.[^5_1]

The problem Vercel needed to solve: **how do you observe what a Lambda function is _actually doing_ from the outside**, so you can bill for active CPU vs. idle I/O wait, and allow multiple concurrent requests to share the same warm instance?

---

## The Custom TCP Tunnel — What It Actually Is

The answer was to break out of Lambda's event-response model entirely using a **custom TCP tunnel** that keeps a persistent bidirectional channel open between each Lambda instance and Vercel's Function Router:[^5_2]

```
Client Request
      │
      ▼
Vercel Function Router
      │
      │  ← persistent TCP tunnel (custom protocol)
      ▼
AWS Lambda Instance
      │
  [your code runs]
      │
  sends packets back through tunnel:
  ┌─────────────────────┐
  │ ResponseStarted     │
  │ ResponseBody chunk  │
  │ ResponseBody chunk  │
  │ ResponseEnd         │
  └─────────────────────┘
```

Instead of Lambda returning a single blob at the end of execution, the function now streams **typed packets** back through the TCP tunnel in real time:[^5_2]

- `ResponseStarted` — headers are ready, start the HTTP response to the client
- `ResponseBody` — one or more chunk packets, streamed as data comes in
- `ResponseEnd` — response is complete, connection can be reused

The Vercel Function Router sits outside Lambda, receives these packets over the TCP tunnel, **reconstructs the HTTP response**, and streams it back to the end client chunk by chunk. Lambda itself never knows it's doing anything unusual — it's just writing to a TCP socket.[^5_2]

---

## How This Enables Active CPU Billing

The TCP tunnel does more than just enable streaming — it gives Vercel **real-time telemetry about what the Lambda instance is doing** at any given millisecond. Because the tunnel is a live channel, Vercel can instrument when:[^5_1]

- Packets are flowing → CPU is active, bill at full CPU rate
- No packets flowing but connection is open → code is `await`-ing I/O, **pause CPU billing**
- Connection closes → function is done, stop memory billing[^5_3]

The billing model that falls out of this is:

- **Active CPU**: billed at ~\$0.128/hr, measured in milliseconds, **paused during I/O waits**[^5_1]
- **Provisioned Memory**: billed continuously at a much lower rate (~\$0.0106/GB-hr) — memory stays allocated even while idle to allow request reuse[^5_3]
- **Invocations**: flat per-call count, unchanged from regular serverless[^5_1]

A function waiting on an OpenAI API call for 800ms pays zero CPU cost for those 800ms — only the cheap memory-provisioning rate. That's why they claim up to **90% cost reduction for AI inference workloads**.[^5_4][^5_1]

---

## The Concurrency Trick — One Lambda, Many Requests

The TCP tunnel also unlocks something structurally new: **a single warm Lambda instance accepting multiple concurrent requests**. Traditional Lambda is 1 request per instance — a new request always needs a new cold or warm instance. With Fluid, the Function Router can route multiple in-flight requests to the same Lambda over the same persistent TCP tunnel, letting them share the warm runtime, loaded modules, and cached state:[^5_5][^5_6][^5_2]

```
Request A ──┐
Request B ──┼──> TCP Tunnel ──> Single Lambda Instance (Node.js runtime)
Request C ──┘                        │
                              handles all 3 concurrently
                              via Node's event loop
```

This is exactly how a traditional Node.js server works — one process, event loop handles concurrent I/O — but now inside Lambda's billing model.[^5_6]

---

## How It Differs from Standard TCP/HTTP Patterns

| Concept        | Standard HTTP server       | Fluid Compute TCP tunnel                                                     |
| :------------- | :------------------------- | :--------------------------------------------------------------------------- |
| Transport      | Client ↔ Server TCP        | Lambda ↔ Vercel Router TCP (reverse tunnel)                                  |
| Direction      | Client opens connection    | **Lambda opens outbound** to Vercel                                          |
| Protocol       | HTTP/1.1 or HTTP/2 framing | **Custom typed packets** (ResponseStarted, ResponseBody, ResponseEnd) [^5_2] |
| Concurrency    | Many clients → one server  | Many clients → one router → one Lambda via tunnel                            |
| Billing signal | External (wall clock)      | **Intrinsic** — packet activity = CPU activity                               |
| Streaming      | SSE / chunked transfer     | Chunked via tunnel, assembled by Router before client                        |

The key inversion here is direction — in normal HTTP, the _client_ opens a TCP connection to the _server_. In Fluid, the **Lambda function opens an outbound TCP connection to Vercel's infrastructure** at startup, creating a persistent reverse tunnel. This is the only way to maintain a live channel from inside a Lambda execution context, since Lambda functions can't accept inbound connections.[^5_2]

---

## How It Compares to Your Protocol Work

This is essentially the same concept you're studying in Boot.dev — custom framing on top of TCP — but applied to solve a real billing/orchestration problem. The `ResponseStarted / ResponseBody / ResponseEnd` packet types are Vercel's own mini-protocol, analogous to how HTTP defines `GET /path HTTP/1.1\r\n` as a structured message format on top of TCP's byte stream. The difference is Vercel controls both ends (Lambda runtime SDK + Function Router), so they can design a protocol that exposes exactly the signals they need for pricing and routing — something you simply can't introspect from outside a standard HTTP response.[^5_2]
<span style="display:none">[^5_10][^5_11][^5_12][^5_13][^5_14][^5_15][^5_7][^5_8][^5_9]</span>

<div align="center">⁂</div>

[^5_1]: https://vercel.com/blog/introducing-active-cpu-pricing-for-fluid-compute

[^5_2]: https://vercel.com/blog/fluid-how-we-built-serverless-servers

[^5_3]: https://vercel.com/docs/functions/usage-and-pricing

[^5_4]: https://www.linkedin.com/posts/delbaoliveira_vercel-pricing-update-cpu-billing-is-now-activity-7346583213693124608-_Fca

[^5_5]: https://dev.to/andycasen/vercels-fluid-compute-and-what-it-means-for-aws-lambda-38dl

[^5_6]: https://www.infoq.com/news/2025/03/vercel-fluid/

[^5_7]: https://vercel.com/docs/fluid-compute

[^5_8]: https://vercel.com/fluid

[^5_9]: https://www.youtube.com/watch?v=itSu3T1zJew

[^5_10]: https://vercel.com/changelog/deployment-level-configuration-for-fluid-compute

[^5_11]: https://vercel.com/docs/functions/configuring-functions/memory

[^5_12]: https://www.reddit.com/r/vercel/comments/1iho1yk/introducing_fluid_compute_the_power_of_servers_in/

[^5_13]: https://www.openstatus.dev/blog/hono-vercel-fluid-compute

[^5_14]: https://www.linkedin.com/posts/vinay-prabhu67_cloudcosts-aws-vercel-activity-7357056043798982657-PZ_0

[^5_15]: https://www.linkedin.com/posts/leeerob_fluid-compute-demo-in-5-minutes-activity-7292674023216291840-k2xB

---

# i mean normally, vercel hosts business application code, sofor every req they spin up a lambda. how a single lambda gets different code req swapped in and out, while the outgoing one is waiting on a network or i/o bound. how does the state persevere, and when the program is not stuck on i/o, how does it get back to the lambda.(cf does it via the js's own event loop concurrency model but with their own v8 isolates, in workerd runtime). so in a single event loop, rather than a single business applications event loop and async code, it's different codebase's one.

This is a genuinely deep question and the answer is different depending on whether you're talking about **Vercel's Node.js Fluid compute** or **Cloudflare's workerd/isolates** — they solve the same problem with fundamentally different architectures.

---

## Vercel Fluid: One Node.js Process, Many Requests

Vercel's approach with Fluid is actually the simpler mental model. They don't do anything exotic at the isolate level — they're just **replicating what a normal Node.js server has always done**, but inside Lambda's container model.[^6_1]

A single Fluid Lambda instance is a **long-lived Node.js process**. Node.js is already built around a single event loop that handles multiple in-flight async operations concurrently. Your business logic for request A is suspended at an `await fetch(...)`, the event loop picks up request B, runs it until _it_ suspends, and so on — standard Node.js concurrency, nothing new:[^6_1]

```
Lambda Instance (single Node.js process)
│
├── Event Loop
│   ├── Request A  → hits await fetch(openai)  → suspended → yields to loop
│   ├── Request B  → hits await db.query()      → suspended → yields to loop
│   ├── Request C  → CPU work (parsing)          → runs synchronously
│   └── Request A resumes ← openai responds ← libuv I/O callback fires
```

The state persists trivially because **it's literally the same process** — `Request A`'s async stack frame, local variables, and closure state sit in the V8 heap untouched while the event loop services other requests. When the I/O resolves, libuv fires the callback, the microtask queue drains, and Request A's `await` resumes exactly where it was. No magic — this is just how Node.js has always worked.[^6_2]

What Fluid adds is:

- The **TCP tunnel** telling the router that this instance has capacity for more concurrent work
- The **CPU billing pause** instrumented via packet flow — when no code is executing and the event loop is idle, the clock stops[^6_3]
- **Bytecode caching** so warm instances don't re-JIT the same function code across requests[^6_4]

---

## The Key Constraint: All Code Must Be the Same Deployment

Here's the critical thing your question is probing — **Fluid does NOT swap different customers' codebases in and out of the same Lambda**. That would be an extreme security violation. Each Lambda instance runs **one deployment's code**. What multiplexes is multiple _requests to the same function_, not requests to different functions or different customers:[^6_1]

```
Customer A's /api/chat ──> Lambda Instance A (customer A's code only)
                               handles: req1, req2, req3... all customer A

Customer B's /api/chat ──> Lambda Instance B (customer B's code only)
                               handles: req1, req2... all customer B
```

Different customers get different Lambda instances. Fluid's concurrency is **within a single tenant's deployment**, not across tenants.[^6_1]

---

## Cloudflare Workers / workerd: The Actually Exotic Model

This is where your question gets interesting — Cloudflare does something structurally different. **workerd** runs hundreds of different customers' code in the same OS process via **V8 Isolates**:[^6_5]

```
workerd OS Process
│
├── V8 Isolate: Customer A's Worker  ← completely isolated heap + globals
├── V8 Isolate: Customer B's Worker  ← completely isolated heap + globals
├── V8 Isolate: Customer C's Worker  ← completely isolated heap + globals
│
└── Single C++ event loop (libuv-like, but Cloudflare's own)
    routes I/O callbacks to the correct isolate
```

A V8 Isolate is a **self-contained JavaScript execution context** — its own heap, its own global object, its own module registry. Isolates cannot share memory or reference each other's objects. The OS sees one process; V8 sees hundreds of hermetically sealed VMs.[^6_5]

The C++ event loop inside workerd is what swaps execution between isolates. When Customer A's worker is `await`-ing a KV read, the event loop parks it and runs Customer B's worker — **different codebases, same event loop, same OS thread**.[^6_5]

### How State Persists Per-Isolate

Each isolate's state persists in its V8 heap for the lifetime of the isolate. But here's the constraint: **Cloudflare Workers isolates have no persistent in-memory state between requests by default** — the isolate can be evicted at any time. A global variable in a Worker is an optimization hint (warm isolate reuse), not a guarantee. Durable Objects are the primitive for truly persistent state — each DO is a single-threaded isolate with guaranteed serialized access and durable storage.[^6_6]

---

## The Deep Distinction

|                                 | Vercel Fluid (Node.js)                                | Cloudflare Workers (workerd)                                            |
| :------------------------------ | :---------------------------------------------------- | :---------------------------------------------------------------------- |
| Isolation unit                  | OS process (one per deployment)                       | V8 Isolate (many per process)                                           |
| Concurrency model               | Node.js event loop — standard JS async/await          | C++ event loop routes across isolates                                   |
| Multi-tenant in one process     | ❌ No — one tenant per Lambda                         | ✅ Yes — hundreds of tenants per workerd process                        |
| Memory sharing between requests | ✅ Same heap, module-level singletons work            | ⚠️ Same isolate if warm, but not guaranteed                             |
| State persistence               | Node.js heap lives as long as Lambda is warm          | Isolate heap lives until eviction; Durable Objects for real persistence |
| Code swapping                   | ❌ Doesn't happen — same code for all concurrent reqs | ✅ Different isolates = different customer code, same loop              |
| Cold start cost                 | Node.js init + your bundle (~ms range)                | V8 Isolate snapshot (~microseconds, sub-1ms) [^6_1]                     |

---

## The Real Insight: It's All Just Cooperative Scheduling

Whether it's Vercel's Node event loop or Cloudflare's C++ workerd loop, the fundamental mechanism is identical to what you studied in the Boot.dev course — **cooperative multitasking**. Every `await` is a yield point. The scheduler (event loop) picks the next runnable coroutine from a queue, runs it until it yields again, and so on.

The only difference is **scope of the scheduler**:

- Node.js event loop → cooperative scheduling across async tasks within _one codebase_
- workerd's C++ loop → cooperative scheduling across V8 isolates each running _different codebases_

Cloudflare's isolate model is essentially running multiple independent JavaScript "threads" on a single-threaded scheduler, where each "thread" happens to be a completely different customer's application. The security guarantee that makes this safe (as opposed to just running everything in one JS context) is that isolates have **no shared mutable state** — the V8 heap boundary is an absolute wall. What workerd is doing at the C++ layer is exactly what your Node.js event loop does at the JS layer, just one level down in the abstraction stack.[^6_5]
<span style="display:none">[^6_10][^6_11][^6_12][^6_13][^6_14][^6_15][^6_16][^6_7][^6_8][^6_9]</span>

<div align="center">⁂</div>

[^6_1]: https://getautonoma.com/blog/vercel-fluid-compute

[^6_2]: https://soomlog.vercel.app/fundamental/All-You-Need-To-Know-About-Event-Loop-1

[^6_3]: https://vercel.com/blog/introducing-active-cpu-pricing-for-fluid-compute

[^6_4]: https://www.linkedin.com/posts/rauchg_things-that-set-vercel-functions-apart-from-activity-7263978278200254464-3mWW

[^6_5]: https://github.com/escrin/workerd

[^6_6]: https://vercel.com/blog/a-new-programming-model-for-durable-execution

[^6_7]: https://vercel.com/docs/functions/runtimes

[^6_8]: https://vercel.com/docs/functions

[^6_9]: https://www.inngest.com/blog/vercel-long-running-background-functions

[^6_10]: https://github.com/vercel/vercel/discussions/9840

[^6_11]: https://vercel.com/docs/functions/concurrency-scaling

[^6_12]: https://stackoverflow.com/questions/73839916/how-to-run-functions-that-take-more-than-10s-on-vercel

[^6_13]: https://github.com/vercel/next.js/discussions/34266

[^6_14]: https://community.vercel.com/t/help-understanding-vercel-metrics-for-function-invocations-and-requests/1699

[^6_15]: https://archive.org/details/github.com-cloudflare-workerd_-_2022-10-01_03-10-22

[^6_16]: https://github.com/vercel/next.js/discussions/36806

---

# like yk I have been trying to implement the exeuction behind active cpu billing in vercel, so that tcp tunnel concept in effectTS. but that tcp tunnel should be able to handle different tenant's codebase and req

This is a genuinely hard systems problem — you're essentially building a mini Cloudflare Workers runtime in Effect-TS. Let me break down exactly what the architecture looks like and where Effect's primitives map.

---

## What You're Actually Building

You want one TCP tunnel (or pool of them) where:

- Multiple _different_ tenants' request handlers run concurrently
- When one tenant's handler awaits I/O, CPU billing pauses and another runs
- State per-request is isolated and preserved across yield points
- The tunnel frame carries enough metadata to route responses back to the right client

This is exactly what workerd does — **one event loop, many isolated execution contexts** — but you're building it in Effect-TS instead of C++/V8.[^7_1]

---

## The Effect Primitives That Map to This

Effect's fiber runtime is the key insight here. Every Effect `Fiber` is a **cooperative coroutine** — it yields at every `await` boundary (Effect calls these `Op` steps). The Effect scheduler has a `shouldYield(fiber)` hook that fires every **2048 ops**, which is the cooperative preemption point:[^7_2]

```ts
// Effect's internal scheduler — already what you need
interface Scheduler {
  shouldYield(fiber: RuntimeFiber<unknown, unknown>): number | false;
  scheduleTask(task: Task, priority: number): void; // ← enqueues fiber resumption
}
```

Every `yield* Effect.sleep(0)` or any async boundary is a `scheduleTask` call — the fiber parks itself and the scheduler picks the next runnable fiber. This is your CPU idle detection point.[^7_1]

---

## The Architecture

Here's how to structure this in Effect-TS:

```
Incoming Request (HTTP/TCP)
       │
       ▼
┌──────────────────────────┐
│   Router (Effect Layer)  │  ← parses frame, extracts tenantId + requestId
└──────────────┬───────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│   Tenant Execution Context Registry          │
│                                              │
│  Map<tenantId, {                             │
│    sandbox: TenantSandbox                    │  ← isolated scope per tenant
│    cpuClock: Ref<CpuAccumulator>             │  ← tracks active cpu ms
│    queue: Queue<TenantRequest>               │  ← incoming work queue
│  }>                                          │
└──────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────┐
│  Per-Tenant Fiber Worker                     │
│                                              │
│  Effect.forever(                             │
│    Queue.take(tenantQueue)                   │  ← waits for next request
│    >>= runWithCpuTracking(handler)           │  ← executes tenant code
│  )                                           │
└──────────────────────────────────────────────┘
               │
      CPU active / idle toggles here
               │
               ▼
┌──────────────────────────────────────────────┐
│  TCP Tunnel (Socket Channel)                 │
│  Frame: { tenantId, requestId, type, body }  │
│  Types: ReqStart | BodyChunk | ReqEnd        │
│         ResStart | ResChunk | ResEnd         │
│         CpuActive | CpuIdle                  │  ← billing signal
└──────────────────────────────────────────────┘
```

---

## The Tenant Isolation Problem

This is the hard part. JavaScript has **no isolate boundary** like V8 isolates — if tenant A's code does `globalThis.foo = "evil"`, tenant B's code sees it. You have a few options, ordered by increasing safety:

### Option 1: Trust Boundary via Module Scope (weakest)

Each tenant's handler is a compiled module function. You wrap it in a closure with a **frozen, tenant-scoped context object** injected as the only way to access globals:

```ts
// Tenant handler receives a sandboxed context — no access to real globals
type TenantHandler = (
  ctx: SandboxedContext,
) => Effect.Effect<Response, AppError>;

interface SandboxedContext {
  readonly env: Readonly<Record<string, string>>; // tenant-specific env vars
  readonly fetch: typeof fetch; // proxied, rate-limited
  readonly kv: KVStore; // tenant-namespaced storage
  // NO access to process, globalThis, require, etc.
}
```

This is basically what Vercel does — tenants are isolated **by convention** (separate Lambda processes), not by runtime VM boundaries.[^7_3]

### Option 2: `vm.runInNewContext` (Node.js built-in)

Node's `vm` module creates a separate V8 context per tenant — their `globalThis` is isolated, but they share the same heap and can still mess with prototype chains via clever object passing:

```ts
import vm from "node:vm";

const tenantCtx = vm.createContext({
  fetch: sandboxedFetch(tenantId),
  console: sandboxedConsole(tenantId),
  // no process, no require, no Buffer unless explicitly granted
});

vm.runInContext(tenantCode, tenantCtx);
```

This is a real isolation boundary but **not sandboxed against CPU/memory abuse** — a tenant can still `while(true){}` and starve everyone.[^7_2]

### Option 3: `worker_threads` per Tenant (closest to workerd)

Each tenant gets a Node.js Worker Thread — a real OS thread with its own V8 isolate, own heap, own event loop. Communication via `MessageChannel`. This is structurally identical to what workerd does, except workerd multiplexes isolates on _one_ thread, while Node Worker Threads use _multiple_ threads:

```ts
import { Worker } from "node:worker_threads";

// Spawn once per tenant, keep warm
const tenantWorker = new Worker("./tenant-runner.js", {
  workerData: { tenantId, envVars },
});

// Route requests via MessageChannel — no shared memory
tenantWorker.postMessage({ type: "REQUEST", requestId, body });
tenantWorker.on("message", ({ type, requestId, chunk }) => {
  // stream response chunks back through TCP tunnel
});
```

---

## The CPU Billing Signal in Effect-TS

This is the clever part. You instrument the `Scheduler` to emit `CpuActive`/`CpuIdle` packets through the TCP tunnel:

```ts
import { Scheduler, Effect, Ref, Clock } from "effect";

const makeCpuTrackingScheduler = (
  tunnel: TcpTunnel,
  tenantId: string,
): Scheduler.Scheduler => ({
  shouldYield: (fiber) => {
    // Effect calls this every 2048 ops — default behavior
    return fiber.currentOpCount > 2048 ? 0 : false;
  },
  scheduleTask: (task, priority) => {
    // task is about to be parked (fiber yielded to I/O or sleep)
    // → emit CpuIdle signal to tunnel
    tunnel.sendFrame({ type: "CpuIdle", tenantId, ts: Date.now() });

    // Schedule resumption via microtask/macrotask
    Promise.resolve().then(() => {
      // fiber is resuming from I/O
      // → emit CpuActive signal
      tunnel.sendFrame({ type: "CpuActive", tenantId, ts: Date.now() });
      task();
    });
  },
});
```

Then you run each tenant's request handler with a **custom runtime** that uses this scheduler:

```ts
const runTenantRequest = (tenantId: string, handler: TenantHandler) =>
  Effect.gen(function* () {
    const customRuntime = yield* Effect.runtime<never>().pipe(
      Effect.map((rt) =>
        rt.pipe(
          // inject the CPU-tracking scheduler for this tenant
          Runtime.provideService(
            Scheduler.Scheduler,
            makeCpuTrackingScheduler(tunnel, tenantId),
          ),
        ),
      ),
    );
    return yield* handler.pipe(Effect.provide(customRuntime));
  });
```

---

## The Frame Protocol (Mini TCP Protocol)

Your TCP tunnel needs a framing layer — exactly what you're learning in Boot.dev, but with tenant routing metadata:

```
┌──────────┬──────────┬──────────┬────────────┬─────────────────┐
│ length   │ tenantId │ requestId│ frameType  │ payload         │
│ (4 bytes)│ (16 bytes│ (16 bytes│ (1 byte)   │ (variable)      │
└──────────┴──────────┴──────────┴────────────┴─────────────────┘

frameType:
  0x01 = ReqStart    (headers, method, path)
  0x02 = ReqBody     (chunk)
  0x03 = ReqEnd
  0x04 = ResStart    (status, headers)
  0x05 = ResChunk    (response body)
  0x06 = ResEnd
  0x07 = CpuActive   ← billing signal
  0x08 = CpuIdle     ← billing signal
  0x09 = TenantError
```

In Effect-TS, this maps to a `Channel<TunnelFrame, TunnelFrame, never>` that you can `pipe` into tenant-specific `Sink`s based on `tenantId + requestId` on each frame.[^7_4]

---

## The Real Challenge You'll Hit

The honest problem is **Effect's fiber scheduler and Node's microtask queue are not the same thing**. When tenant code calls a real `fetch()`, the Promise resolution goes through Node's own microtask queue, not Effect's `scheduleTask` — so your CPU idle signal fires correctly, but the _resumption_ signal fires at Promise-resolution time which is outside your scheduler's control. You'll need to **proxy all I/O** (wrap `fetch`, `setTimeout`, db calls) so every async boundary passes through your scheduler's `scheduleTask`, not native Promise microtasks. This is exactly the hard thing workerd solved by patching V8 directly — you'll be doing it in userland.[^7_5][^7_2]

The cleanest solution is to ensure all tenant code is written as Effect (so all async boundaries go through Effect's fiber scheduler), which is natural if you control the tenant SDK. If tenants bring arbitrary JS, you need the `worker_threads` isolation model and accept that cross-thread messaging replaces scheduler-level CPU telemetry.
<span style="display:none">[^7_10][^7_11][^7_12][^7_13][^7_14][^7_15][^7_16][^7_17][^7_18][^7_6][^7_7][^7_8][^7_9]</span>

<div align="center">⁂</div>

[^7_1]: https://effect-ts.github.io/effect/effect/Scheduler.ts.html

[^7_2]: https://deepwiki.com/Effect-TS/effect/3.1-fibers

[^7_3]: https://getautonoma.com/blog/vercel-fluid-compute

[^7_4]: https://effect-ts.github.io/effect/platform/Socket.ts.html

[^7_5]: https://github.com/escrin/workerd

[^7_6]: https://dev.to/baldrvivaldelli/building-an-effect-runtime-in-typescript-my-little-detour-into-fibers-and-structured-concurrency-mad

[^7_7]: https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Effect.ts

[^7_8]: https://effect.website/docs/guides/concurrency/fibers

[^7_9]: https://patents.google.com/patent/WO2023015311A1/en

[^7_10]: https://typelevel.org/cats-effect/docs/schedulers

[^7_11]: https://docs.aws.amazon.com/iot/latest/developerguide/multiplexing.html

[^7_12]: https://effect.website/docs/concurrency/fibers/

[^7_13]: https://gist.github.com/natevw/f7934b0f0ef49d8254b6

[^7_14]: https://www.mintlify.com/effect-TS/effect-smol/api/fiber

[^7_15]: https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/networking

[^7_16]: https://effect-ts.github.io/effect/effect/Fiber.ts.html

[^7_17]: https://frontegg.com/guides/multi-tenant-architecture

[^7_18]: https://skill4agent.com/en/skill/kastalien-research-thoughtbox-dot-claude/effect-ts

---

# so per tenant tcp tunnel is better?

Yes — and actually, Vercel's own architecture confirms this is exactly the right call. Here's the sharp reasoning:

---

## Vercel's Answer: One Tunnel Per Function Instance

Vercel's actual implementation is **one TCP tunnel per Lambda instance**, and each Lambda instance serves **one tenant's deployment only**. The tunnel isn't multi-tenant at the wire level — tenant isolation happens at the Lambda/process boundary, and the tunnel is purely the communication pipe between that process and the Function Router.[^8_1][^8_2]

So for your implementation, **per-tenant tunnel is the correct model** — and here's exactly why the alternative (multiplexed multi-tenant tunnel) creates problems:

---

## The Trade-off Table

| Design                  | Per-Tenant Tunnel                                          | Single Multiplexed Tunnel                             |
| :---------------------- | :--------------------------------------------------------- | :---------------------------------------------------- |
| CPU billing granularity | Clean — one tunnel's packet flow = one tenant's CPU signal | Ambiguous — need per-frame timestamps, noisy          |
| Isolation               | Strong — tenant A's crash closes _only_ its tunnel         | Weak — one bad tenant errors the shared socket        |
| Backpressure            | Per-tenant flow control naturally                          | You re-implement QUIC stream backpressure manually    |
| Router complexity       | Simple — `Map<tenantId, Socket>`                           | Every frame needs `tenantId` routing, reorder buffers |
| Noisy neighbor          | ❌ Impossible at TCP level                                 | ✅ Tenant A flooding frames starves tenant B          |
| CPU idle detection      | `socket.idle === true` = whole tenant is idle              | Need per-frame timing deltas — much harder            |
| Effect-TS fit           | One `Socket` channel per `Scope` — perfect match           | One channel, many `Stream.partition` splits — fragile |

The multiplexed design is what **QUIC streams** were invented to solve. If you want that model, you're re-implementing QUIC in userland — which is exactly the wrong direction.[^8_3]

---

## The Right Architecture in Effect-TS

```
Router (single process)
│
├── TenantRegistry: Map<tenantId, TenantWorker>
│
├── TenantWorker (per tenant)
│   ├── Socket: Channel<Uint8Array, Uint8Array>   ← dedicated TCP tunnel
│   ├── CpuClock: Ref<{ active: bigint, idle: bigint }>
│   ├── RequestQueue: Queue<IncomingRequest>
│   └── Fiber: running Effect.forever(handler loop)
│
└── Billing Aggregator: polls CpuClock refs, emits invoices
```

In Effect-TS, each `TenantWorker` lives in its own `Scope` — if the tenant's tunnel drops, its `Scope` closes, resources are released, and the router just spawns a new worker:[^8_4]

```ts
const makeTenantWorker = (tenantId: string, handler: TenantHandler) =>
  Effect.gen(function* () {
    // Each tenant gets its own scoped TCP socket
    const socket = yield* Socket.Socket; // from @effect/platform
    const cpuClock = yield* Ref.make({ active: 0n, idle: 0n });

    // CPU idle = socket waiting for next packet = no active fiber work
    const runWithCpuTracking = (req: Request) =>
      Effect.gen(function* () {
        yield* Ref.update(cpuClock, (c) => ({ ...c, active: c.active + 1n }));
        const res = yield* handler(req);
        yield* Ref.update(cpuClock, (c) => ({ ...c, idle: c.idle + 1n }));
        return res;
      });

    // Emit CpuActive/CpuIdle frames through the tunnel on each transition
    yield* Effect.forever(
      Queue.take(requestQueue).pipe(
        Effect.flatMap(runWithCpuTracking),
        Effect.flatMap((res) => sendResponseFrames(socket, tenantId, res)),
      ),
    );
  }).pipe(Effect.scoped); // ← whole worker cleans up if tunnel dies
```

The `Effect.scoped` at the bottom is the key — it's a guarantee that no matter what kills this worker (crash, timeout, tenant eviction), the TCP socket closes cleanly and the billing clock stops.[^8_5][^8_4]

---

## When You'd Want Per-Request Tunnels Instead

If you're building something closer to Cloudflare Workers (many tenants, ultra-low per-tenant traffic), a per-tenant persistent tunnel is wasteful — a tenant with 1 req/day shouldn't hold an open TCP socket forever. In that case, the architecture shifts to:

- **Shared tunnel pool** with short-lived per-request logical sessions
- Tenant isolation via `worker_threads` (V8 isolate boundary) not TCP tunnel boundary
- CPU billing via `performance.now()` deltas bracketing each isolate's execution slot

But that's the workerd architecture — it's the harder problem because you're doing cooperative scheduling _across tenant isolates_, not just across async tasks within one tenant. Per-tenant tunnel sidesteps this entirely by making the process boundary do the isolation work, which is simpler, safer, and exactly what Vercel chose.[^8_6][^8_1]

**Start with per-tenant tunnels.** It maps cleanly to Effect's `Scope` + `Socket` model, gives you clean CPU signal semantics, and avoids rebuilding QUIC stream multiplexing by hand.
<span style="display:none">[^8_10][^8_11][^8_12][^8_13][^8_14][^8_15][^8_16][^8_17][^8_18][^8_7][^8_8][^8_9]</span>

<div align="center">⁂</div>

[^8_1]: https://vercel.com/blog/fluid-how-we-built-serverless-servers

[^8_2]: https://ssojet.com/blog/news-2025-03-vercel-fluid/

[^8_3]: https://patents.google.com/patent/WO2023015311A1/en

[^8_4]: https://effect.website/docs/guides/concurrency/fibers

[^8_5]: https://deepwiki.com/Effect-TS/effect/3.1-fibers

[^8_6]: https://techcodex.io/blog/2025/03/cloudflare-avoids-containers-workers/

[^8_7]: https://vercel.com/docs/fluid-compute

[^8_8]: https://app.daily.dev/posts/fluid-compute-how-we-built-serverless-servers-fich4ydhd

[^8_9]: https://meshan.dev/blog/coffee-codex-fluid/

[^8_10]: https://architectingoncloudflare.com/chapter-23/

[^8_11]: https://www.usenix.org/event/nsdi11/tech/full_papers/Shieh.pdf

[^8_12]: https://www.linkedin.com/pulse/fluid-compute-active-cpu-pricing-vercel-innovation-how-marlatto-6o63e

[^8_13]: https://eastondev.com/blog/en/posts/dev/20260425-cloudflare-dynamic-workers/

[^8_14]: https://www.elastic.co/docs/reference/integrations/network_traffic

[^8_15]: https://ssojet.com/blog/news-2025-03-vercel-fluid

[^8_16]: https://stealthcloud.ai/case-studies/cloudflare-workers-zero-trust/

[^8_17]: https://oms.bdu.ac.in/ec-colleges/admin/contents/9_P16CS41_2020051303532767.pdf

[^8_18]: https://assets.ctfassets.net/e5382hct74si/2B6mqMu7zeFco4XFGzraya/7b9b0b736d2b8148f34fc8f8666a6305/Vercel_Fluid_Whitepaper.pdf

---

# so the tenantcode gets hit 100k req in 10mins, vercel doesn't have to provision 100k lambdas for it

Yes — and this is the **entire point** of Fluid compute. Here's exactly how the math works:

---

## Old Lambda Model: 1 Request = 1 Instance

Before Fluid, Vercel was pure AWS Lambda semantics:[^9_1]

```
100k requests → 100k Lambda instances (or queue behind concurrency limits)
Each instance: boots, handles 1 req, idles 800ms waiting on DB/OpenAI, dies
You pay for: 100k × (boot time + actual work + idle wait)
```

This is catastrophically wasteful for I/O-heavy workloads. A Next.js SSR page hitting a database spends ~80% of its Lambda duration just `await`-ing — you're billed for all of it.[^9_2]

---

## Fluid Model: N Requests → M Instances (M << N)

Fluid breaks the 1:1 mapping entirely. A single Lambda instance can now handle **multiple concurrent requests** — the Function Router is smart about it:[^9_3]

```
100k requests in 10 mins = ~167 req/sec peak

Each request: 200ms total, but 150ms is await DB/LLM (idle CPU)
Active CPU per req: ~50ms

One Lambda instance can interleave:
  Req A: runs 10ms → hits await → parks
  Req B: runs 10ms → hits await → parks
  Req C: runs 10ms → hits await → parks
  Req A: DB responds → resumes → runs 20ms → done
  ...
```

One instance effectively handles concurrent requests up to its memory limit — not one-at-a-time. The Router picks the instance with **most available resources and fewest concurrent requests** rather than round-robin.[^9_1][^9_2]

So for 100k requests:

| Model      | Lambda Instances Needed   | What You Pay                              |
| :--------- | :------------------------ | :---------------------------------------- |
| Old Lambda | ~100k (one per req)       | 100k invocations × wall clock time [^9_4] |
| Fluid      | Maybe ~500–2000 instances | Active CPU ms + cheap idle memory [^9_5]  |

Vercel's own numbers: **20–50% compute cost reduction** on I/O workloads, and one case study (Verse, 15k concurrent users) saw **50%+ cost reduction**.[^9_6][^9_2]

---

## How the Router Decides When to Spin a New Lambda

The Router sends a request to a warm instance and the instance either **accepts** or sends back a `NACK` (not-acknowledged) if it's at capacity. The Router has a timeout — if no warm instance accepts within a threshold, it spins a new cold Lambda. So the actual Lambda count is demand-driven, not request-driven:[^9_1]

```
Req 1  → Router sends to Instance A → ACK  (A now handling 1)
Req 2  → Router sends to Instance A → ACK  (A now handling 2)
...
Req 10 → Router sends to Instance A → NACK (A at concurrency cap)
       → Router spins Instance B    → cold start
Req 11 → Router sends to Instance B → ACK
```

The concurrency cap per instance is configurable — during beta, Vercel is slowly raising it as they build confidence in the scheduling behavior. At the platform level, Vercel scales out at **1,000 new Lambda instances per 10 seconds** for burst traffic, up to **30,000 concurrent instances on Pro and 100,000 on Enterprise**. So for a true 100k req/sec spike, it would spin new instances, but far fewer than 100k since each handles N concurrent requests.[^9_7][^9_6]

---

## The CPU Billing Elegance

The active CPU billing is what makes this economically coherent for the customer. Without it, you'd have a perverse incentive problem: a single Lambda handling 10 concurrent requests might look like it's "working" all the time (wall clock never idles) even though 90% of wall clock is just `await`-ing I/O across all 10 requests. With active CPU billing:[^9_5]

- **You pay only when your code is actually executing** — the `CpuActive` frames flowing through the TCP tunnel
- **Idle I/O wait across all concurrent requests** is billed at the cheap provisioned-memory rate[^9_8]
- The more concurrent requests an instance handles during I/O waits, the **better** for the customer — CPU cost stays flat, more work gets done[^9_2]

This is why the TCP tunnel's `CpuActive`/`CpuIdle` packet design is so critical — it's not just telemetry, it's **the billing instrument**. For your Effect-TS implementation, this maps cleanly: a tenant's `Scope` being active with running Fibers = `CpuActive` frames flowing; all Fibers parked on `await` = `CpuIdle` frame, billing clock pauses.[^9_1]
<span style="display:none">[^9_10][^9_11][^9_12][^9_13][^9_14][^9_15][^9_16][^9_17][^9_9]</span>

<div align="center">⁂</div>

[^9_1]: https://vercel.com/blog/fluid-how-we-built-serverless-servers

[^9_2]: https://vercel.com/blog/serverless-servers-node-js-with-in-function-concurrency

[^9_3]: https://getautonoma.com/blog/vercel-fluid-compute

[^9_4]: https://dev.to/andycasen/vercels-fluid-compute-and-what-it-means-for-aws-lambda-38dl

[^9_5]: https://vercel.com/blog/introducing-active-cpu-pricing-for-fluid-compute

[^9_6]: https://vercel.com/changelog/in-function-concurrency-now-in-public-beta

[^9_7]: https://vercel.com/docs/functions/concurrency-scaling

[^9_8]: https://vercel.com/docs/functions/usage-and-pricing

[^9_9]: https://vercel.com/blog/behind-the-scenes-of-vercels-infrastructure

[^9_10]: https://vercel.com/docs/functions

[^9_11]: https://www.hashstudioz.com/blog/serverless-web-application-development-cost-comparison-aws-lambda-vs-vercel-edge/

[^9_12]: https://vercel.com/docs/fundamentals/infrastructure

[^9_13]: https://www.codematic.be/de/blog/14

[^9_14]: https://vercel.com/changelog/vercel-functions-now-scale-12x-faster-for-high-volume-requests

[^9_15]: https://x.com/vercel/status/1841867667038179721

[^9_16]: https://vercel.com/blog/streaming-for-serverless-node-js-and-edge-runtimes-with-vercel-functions

[^9_17]: https://news.ycombinator.com/item?id=31912794

---

# how can i abstract that into something a business can use for their usecase, so for a single tenant of aws lambdas firing on every request.

You're essentially asking: **how do you build a Fluid-like layer as a product that any business can drop in front of their existing Lambda functions** — so they get in-function concurrency and active CPU billing without rewriting their infra.

This is a real product gap. Here's how to think about the abstraction layers:

---

## What You're Building

A **compute proxy layer** that sits between the business's incoming traffic and their Lambda functions, transparently enabling request multiplexing and active-CPU-only billing:

```
Client Requests
      │
      ▼
┌─────────────────────────────┐
│   Your Router / Proxy       │  ← your product
│   (runs on a long-lived     │
│    server, not Lambda)      │
└────────────┬────────────────┘
             │  persistent TCP tunnel per warm instance
             ▼
┌─────────────────────────────┐
│   Customer's Lambda Fn      │  ← their existing code, zero changes
│   + your thin SDK shim      │  ← one import, injects tunnel client
└─────────────────────────────┘
```

The customer adds **one package** to their Lambda handler. Their code doesn't change. You handle all the multiplexing, CPU tracking, and billing logic in your Router.

---

## The Three Abstractions

### 1. The SDK Shim (Customer-Facing)

This is what the business installs. It wraps their Lambda handler and opens the outbound TCP tunnel on cold start:

```ts
// @your-product/sdk — customer installs this
import { createFluidHandler } from "@your-product/sdk";

// Before: standard Lambda handler
export const handler = async (event, context) => {
  return { statusCode: 200, body: "hello" };
};

// After: one wrapper, zero logic changes
export const handler = createFluidHandler(async (req) => {
  return { statusCode: 200, body: "hello" };
});
```

Internally `createFluidHandler` does:

- Opens an **outbound TCP connection** to your Router on cold start
- Reads frames off the connection (`ReqStart`, `ReqBody`, `ReqEnd`)
- Dispatches each request to the customer's handler as a new async task
- Streams `ResChunk` frames back as the handler produces output
- Emits `CpuActive`/`CpuIdle` frames around every `await` boundary
- Sends a `Heartbeat` frame every N seconds so the Router knows the instance is alive

The customer's Lambda **never returns** to AWS until the tunnel dies — it loops forever reading from the socket, handling concurrent requests through the Node event loop. Lambda's own timeout becomes your maximum instance lifetime.

### 2. The Router (Your Core Infrastructure)

This is your product's brain — a long-lived server (not Lambda) that:

- Accepts inbound HTTP requests from the internet
- Maintains a `Map<deploymentId, WarmInstance[]>` registry of tunnel connections
- Routes each incoming request to the least-loaded warm instance
- Falls back to triggering a new Lambda cold start (via AWS SDK invoke) if no warm instance has capacity
- Tracks `CpuActive`/`CpuIdle` frames per instance to compute billing

```ts
// Router core — your product's server
const routeRequest = (deploymentId: string, req: IncomingRequest) =>
  Effect.gen(function* () {
    const instances = yield* Registry.getWarm(deploymentId);
    const target = instances.find((i) => i.concurrency < i.maxConcurrency);

    if (!target) {
      // no warm capacity — cold start a new Lambda
      yield* Lambda.invoke(deploymentId);
      yield* Effect.sleep("200 millis"); // wait for tunnel to connect back
      return yield* routeRequest(deploymentId, req); // retry
    }

    // forward request over the tunnel, stream response back
    yield* target.tunnel.sendFrame({
      type: "ReqStart",
      requestId,
      headers: req.headers,
    });
    yield* Stream.run(
      req.body,
      Sink.forEach((chunk) =>
        target.tunnel.sendFrame({ type: "ReqBody", requestId, chunk }),
      ),
    );
    yield* target.tunnel.sendFrame({ type: "ReqEnd", requestId });
  });
```

### 3. The Billing Engine

The TCP tunnel's `CpuActive`/`CpuIdle` frames are timestamped. The billing engine accumulates active CPU milliseconds per `deploymentId` and exposes a usage dashboard:

```ts
// Billing accumulator per deployment
interface BillingLedger {
  deploymentId: string;
  activeCpuMs: bigint; // sum of all CpuActive → CpuIdle intervals
  provisionedMemMs: bigint; // wall clock × memory since instance started
  invocations: number; // cold starts triggered
}
```

Customer sees on their dashboard: **"You used 430ms of active CPU across 1,200 requests — instead of paying for 1,200 × 800ms wall clock, you paid for 430ms total."**

---

## The Business Model

This maps to a **managed infrastructure product** — you're selling it as a drop-in layer with a pricing model that's strictly cheaper than raw Lambda for I/O-bound workloads:

| Tier                | What They Pay You         | What They Save                                    |
| :------------------ | :------------------------ | :------------------------------------------------ |
| Active CPU          | \$/ms of actual execution | Don't pay for DB/API wait time                    |
| Memory provisioning | \$/GB-hr (cheap)          | Same as before, but shared across concurrent reqs |
| Cold starts         | \$/invocation (flat)      | 10–50× fewer invocations due to multiplexing      |

The **sales pitch to a business** is pure cost math: if they're running an AI-heavy Next.js app where each request spends 700ms waiting on an LLM and 50ms executing, they're currently paying for 750ms per request. With your product, 20 concurrent requests share one instance, all their LLM waits overlap, and they pay 50ms × 20 = 1,000ms total instead of 750ms × 20 = 15,000ms. That's a **15× cost reduction** on that workload.

---

## What Makes This Hard (The Real Engineering)

Three non-obvious problems you'll hit:

**1. Lambda can't accept inbound connections.** Your shim must open the tunnel _outbound_ — the Lambda dials your Router, not the other way around. This means you need a **registration handshake**: Lambda starts, opens TCP to your Router, sends `{ deploymentId, instanceId, maxConcurrency }`, and the Router adds it to the warm registry. This is exactly what Vercel's architecture does.[^10_1]

**2. Lambda's 15-minute hard timeout kills idle instances.** Your Router must track tunnel age and proactively trigger a new cold start before an instance times out, then drain in-flight requests to the old instance and cut over. Effect's `Schedule` and `Scope` compose naturally for this — `Effect.acquireRelease` on each tunnel connection handles graceful drain on scope close.

**3. AWS Lambda's invocation model fights you.** A standard Lambda invocation expects a response payload — your tunnel loop never returns one. You need to use **Lambda response streaming** (AWS's own feature) or invoke with `InvocationType: "Event"` (fire-and-forget) and treat the tunnel as the real response channel instead. The AWS Lambda response streaming API maps cleanly to your `ResChunk` frame model.

---

## The Effect-TS Architecture for All of This

```ts
// Top-level program — your Router service
const RouterProgram = Effect.gen(function* () {
  const registry = yield* TunnelRegistry; // Map<deploymentId, TunnelPool>
  const billing = yield* BillingEngine; // accumulates CpuActive frames
  const httpServer = yield* HttpServer.serve(routeRequest(registry, billing));
  const tunnelServer = yield* TcpServer.listen(
    5000,
    handleTunnelConnect(registry, billing),
  );

  yield* Effect.all([httpServer, tunnelServer], { concurrency: "unbounded" });
}).pipe(Effect.provide(NodeContext.layer), Effect.scoped);
```

Each `TunnelPool` is a `Ref<TunnelConnection[]>` — when a Lambda dials in, you `Ref.update` to add it; when its scope closes (tunnel drops), the `Ref` shrinks. The billing engine subscribes to a `PubSub<BillingFrame>` that all tunnel connections publish `CpuActive`/`CpuIdle` events to — fully decoupled from routing logic.

The product is genuinely buildable. The SDK shim is maybe 200 lines of TypeScript, the Router is the real work (~2–3k lines in Effect), and the hardest part is the Lambda lifecycle management around timeouts and draining. But the core TCP tunnel + frame protocol is exactly what you've been learning — just with a product wrapper around it.

<div align="center">⁂</div>

[^10_1]: https://vercel.com/blog/fluid-how-we-built-serverless-servers

---

# and like not just nodejs specific instance, lambda can take any runtime right, while my infra handling logic stays in effectTS, the dev just drops it into their codebase

Exactly — and this is what makes it a real platform product rather than a Node.js utility. Lambda supports Go, Python, Rust, Java, .NET, Ruby, and custom runtimes via the Runtime API. Your infra logic stays in Effect-TS on the Router side; the tenant just drops a thin **language-native shim** into their existing handler.

---

## The Key Insight: Lambda Runtime API is the Abstraction

AWS exposes a **Lambda Runtime API** — a local HTTP server running at `http://${AWS_LAMBDA_RUNTIME_API}` that every Lambda runtime polls for invocations. Every language's Lambda SDK (Node, Python, Go, Rust) is just a loop hitting this local API. Your shim replaces that loop with your own tunnel-based loop — the customer's actual business logic function doesn't change:[^11_1]

```
Normal Lambda lifecycle:
  Runtime polls http://127.0.0.1:9001/runtime/invocation/next
  → gets event
  → calls customer handler(event)
  → POSTs result to /runtime/invocation/{id}/response

Your shim lifecycle:
  Shim opens TCP tunnel to your Router
  → gets ReqStart frame
  → calls customer handler(event)  ← identical call
  → streams ResChunk frames back through tunnel
```

The customer's code sees zero difference. The Lambda Runtime API loop is fully replaced by your tunnel loop inside the shim.

---

## Per-Language Shim Interface

Each language shim is tiny — it only needs to:

1. Open the outbound TCP tunnel on startup
2. Read `ReqStart` frames and deserialize to the language-native request type
3. Call the customer's handler
4. Stream response frames back
5. Emit `CpuActive`/`CpuIdle` signals around `await`/goroutine yield points

```
┌─────────────────────────────────────────────────────────────┐
│              Your Router (Effect-TS, unchanged)             │
│         speaks one wire protocol: TCP frame format          │
└──────┬───────────┬──────────────┬────────────┬─────────────┘
       │           │              │            │
  Node shim    Python shim    Go shim      Rust shim
  (100 lines   (100 lines     (150 lines   (150 lines
   TS/JS)       Python)        Go)          Rust)
       │           │              │            │
  customer's   customer's    customer's   customer's
  handler.ts   handler.py    handler.go   handler.rs
  unchanged    unchanged     unchanged    unchanged
```

The wire protocol is the stable contract. Each shim is just a thin adapter between your frame format and the language's native async model.

---

## What Each Shim Looks Like

### Python

```python
# pip install your-product-sdk
from your_sdk import fluid_handler

@fluid_handler   # ← one decorator, that's it
def handler(event, context):
    response = requests.get("https://api.example.com/data")  # I/O → CpuIdle emitted
    return {"statusCode": 200, "body": response.text}
```

The decorator wraps the function, opens the tunnel via Python's `asyncio` + `socket`, and uses `asyncio` event loop hooks to detect when coroutines yield on I/O — same cooperative scheduling model as Node.js, just Python's event loop instead.[^11_2]

### Go

```go
// go get your-product/sdk
import fluid "github.com/your-product/sdk"

func handler(ctx context.Context, event events.APIGatewayRequest) (events.APIGatewayResponse, error) {
    resp, err := http.Get("https://api.example.com")  // I/O → goroutine yields
    return events.APIGatewayResponse{StatusCode: 200}, err
}

func main() {
    fluid.Start(handler)  // ← replaces lambda.Start(handler)
}
```

Go's goroutine scheduler is the interesting case — you can't hook into goroutine yield points from userland like you can in Node or Python. Instead, you instrument at the **I/O syscall boundary** using Go's `net/http` transport wrapper: wrap the `http.Transport`, bracket each `RoundTrip()` call with `CpuIdle`/`CpuActive` frames. Same result, different hook point.

### Rust

```rust
// Cargo.toml: your-product-sdk = "0.1"
use your_sdk::fluid_handler;

#[fluid_handler]  // proc macro — wraps main()
async fn handler(event: Request) -> Result<Response, Error> {
    let data = reqwest::get("https://api.example.com").await?;  // .await → tokio yields
    Ok(Response::new(data.text().await?))
}
```

Rust with Tokio is actually the cleanest — every `.await` point is an explicit yield in the source code, and Tokio's `task::spawn` maps directly to Effect's `Fiber.fork`. You can hook `CpuActive`/`CpuIdle` into a custom Tokio task `LocalSet` instrumentation layer.

---

## The CPU Signal Problem Per Language

Each language's async model has a different hook point for detecting I/O yield:

| Language   | Async model              | Where you hook CPU idle detection                            |
| :--------- | :----------------------- | :----------------------------------------------------------- |
| Node.js    | Event loop + microtasks  | Effect Scheduler's `scheduleTask`                            |
| Python     | `asyncio` event loop     | `loop.set_task_factory` + `Task.__step` wrap                 |
| Go         | Goroutine scheduler      | Wrap `net/http.Transport.RoundTrip` + `time.Sleep`           |
| Rust/Tokio | `.await` yield points    | Custom `tokio::runtime::Builder` with task hooks             |
| Java       | Virtual threads (JDK 21) | `Thread.ofVirtual()` + `StructuredTaskScope` instrumentation |

Go and Java are the hardest because goroutines and virtual threads are scheduled by the runtime, not userland. You don't get a callback when a goroutine parks — you have to instrument at the I/O call sites instead of the scheduler level. The signal is slightly less precise (you miss pure CPU-bound goroutine context switches) but good enough for billing — the workloads that benefit most from your product are I/O-heavy anyway.

---

## The Architecture That Falls Out

```
Your Router (Effect-TS)
│
├── Protocol layer: frame encode/decode (language-agnostic binary format)
├── Registry: Map<deploymentId, { runtime, tunnelPool }>
├── Billing: PubSub<CpuFrame> → aggregator → invoice
└── Lambda orchestrator: AWS SDK invokes cold starts for any runtime
        │
        ├── invokeLambda(nodejs, deploymentId)
        ├── invokeLambda(python, deploymentId)
        ├── invokeLambda(go, deploymentId)
        └── invokeLambda(rust, deploymentId)
          ← same TCP tunnel protocol regardless of runtime
```

The Router doesn't know or care what language the Lambda is running. It speaks frames. The shim on the other end speaks frames. The language is an **implementation detail of the shim**, invisible to your Router entirely.

---

## What This Means as a Product

The customer onboarding is:

1. **Install SDK**: `npm install @your/sdk` / `pip install your-sdk` / `go get your/sdk`
2. **Wrap handler**: one decorator / wrapper call
3. **Set env var**: `YOUR_ROUTER_URL=wss://router.yourproduct.com`
4. **Deploy normally**: same `serverless deploy` / `cdk deploy` / `terraform apply` they already use

No infra changes. No IAM role changes beyond allowing outbound TCP from Lambda (which is default). No rewriting business logic. Their existing CI/CD pipeline works unchanged.

The platform **accretes value** as they add more Lambda functions — each one drops the shim in, each one joins the Router's warm pool, each one gets active-CPU billing. The more I/O-bound their workload, the more they save — and AI/LLM workloads are the most I/O-bound workloads that exist right now, which is exactly who has budget and pain.

<div align="center">⁂</div>

[^11_1]: https://vercel.com/blog/fluid-how-we-built-serverless-servers

[^11_2]: https://deepwiki.com/Effect-TS/effect/3.1-fibers
