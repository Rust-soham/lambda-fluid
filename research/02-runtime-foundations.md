# Vercel Fluid Compute

## Why the Tunnel Exists

Vercel's public architecture describes a bidirectional protocol between the
Vercel Function Router and a function instance. It lets the platform stream
responses that do not fit Lambda's ordinary request-in, final-response-out
shape. This was especially important for React Server Components and other
incremental response flows.

The key consequence is larger than streaming alone: once the connection is
open, the router can deliver another request to the same live function instance
instead of treating the instance as permanently occupied by one request.

## Vercel's Published Components

```text
Request
  -> Vercel Proxy
  -> compute-resolver
  -> Function Router
  -> secure TCP-based protocol
  -> Rust core inside the Lambda environment
  -> Node.js or Python function process
```

The public description identifies these responsibilities:

- **Function Router:** owns live connections and routes requests.
- **compute-resolver:** routes toward a Function Router likely to already have
  the relevant function connection.
- **Rust core:** bridges the router protocol to the language process and
  monitors CPU, memory, event-loop delay, file descriptors, and connection
  state.
- **In-function concurrency:** a function instance can accept more than one
  request.
- **Nack:** an overloaded instance can refuse a new request.
- **Streaming frames:** response start, body chunks, and response end travel
  incrementally.

Lambda Fluid is a learning reconstruction. Its Node worker may initially
combine the Rust-core and language-process responsibilities, but must call that
out as a difference from Vercel.

## Pack and Scale, Together

The router has two simultaneous responsibilities:

1. Reuse a connected worker when it has safe capacity.
2. Start another worker when packing would violate latency or resource limits.

For a burst of 1,000 requests, the correct answer is not automatically 1,000
workers or a tiny fixed pool. The number depends on:

- already-warm capacity;
- request CPU and I/O profile;
- concurrency limit per worker;
- event-loop lag, memory, and CPU pressure;
- target latency;
- cold-start and worker-registration speed;
- provider scaling limits.

I/O-heavy requests can share one worker while several are awaiting remote work.
CPU-heavy requests push the worker count closer to request concurrency. The
desired fleet is the smallest one that satisfies the latency objective.

## What Happens at an I/O Boundary

```text
request A runs CPU
request A awaits a database or network response
request A's continuation stays in the worker heap
the Node event loop runs request B if ready
request A resumes in the same worker when I/O completes
```

The tunnel does not swap A out, move it to another Lambda, or replace part of a
TCP port. It gives the router a route to send B into capacity that would
otherwise be idle.

## Scale-Down

Vercel can stop charging provisioned memory once the last in-flight request
finishes. A custom Lambda worker with an intentionally open outer invocation is
different: AWS continues duration billing until that invocation returns.

Lambda Fluid therefore needs an explicit idle policy:

1. stop admitting work after an idle grace period;
2. announce drain;
3. wait for active work or its deadline;
4. flush final metrics;
5. close the tunnel;
6. return from the Lambda invocation.

## Active CPU Pricing Boundary

Vercel's current pricing model separates active CPU, provisioned memory, and
invocations. AWS Lambda does not become active-CPU-billed merely because this
project multiplexes work.

Lambda Fluid can measure:

- conventional AWS worker invocation duration;
- aggregate process CPU time;
- request wait and response timing;
- worker utilization.

It can present Vercel's pricing as a parameterized explanatory comparison, but
it must never represent that comparison as the AWS bill.

## Cloudflare, Only as Contrast

Cloudflare is useful for one sentence of context: it owns an isolate runtime,
whereas Vercel built a router and runtime harness over Lambda. That contrast
belongs in an article introduction, not in this project's implementation
scope.
