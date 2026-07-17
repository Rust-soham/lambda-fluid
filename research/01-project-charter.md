# Project Charter

## Objective

Build a compact, measurable reconstruction of the mechanics that make Vercel
Fluid Compute interesting on AWS Lambda:

- streaming through a bidirectional connection;
- multiple in-flight requests in one function instance;
- resource-aware admission and routing;
- scale-out when existing instances cannot safely meet latency targets;
- explicit worker drain and retirement.

The result should explain the architecture with real traces and measurements,
not imitate Vercel's private fleet or claim access to its economics.

## The Core Mental Model

```text
Client HTTP request
        |
        v
Orchestrator / Function Router analogue
        |
        | persistent bidirectional tunnel
        v
Long-running Lambda worker invocation
        |
        |- request A: CPU -> await I/O -> CPU
        |- request B: CPU -> await I/O -> CPU
        `- request C: streamed response
```

When request A awaits I/O, it remains suspended in the worker's memory. It is
not moved to another Lambda. The worker's event loop can run B, and the tunnel
allows the router to send B to that worker if it has safe capacity.

## Primary Deliverable

A live demo and benchmark that shows:

1. Lambda workers registering through outbound tunnels.
2. A request stream and response stream crossing the tunnel.
3. Concurrent requests interleaving inside each worker.
4. Worker health, in-flight count, nack, and drain events.
5. A burst where routing both packs into existing workers and creates more
   workers when latency/resource limits require it.
6. Idle workers draining and ending their outer invocation.
7. A matched conventional-Lambda baseline and raw measurement artifacts.

## Scope

### In scope

- Node.js worker runtime and Effect v4 orchestration.
- AWS Lambda as the underlying execution substrate.
- A persistent orchestrator with public HTTP and secure worker tunnel listener.
- Streaming frame protocol.
- Resource-aware routing, bounded concurrency, nack, reconnect, drain, and
  idle scale-down.
- Local integration tests and a live AWS benchmark.
- Alchemy-managed infrastructure after local correctness is established.

### Explicitly out of scope

- A Cloudflare implementation or Durable Object demo.
- A generic multi-language SDK.
- Arbitrary untrusted tenant code in shared workers.
- A global Vercel-like compute resolver fleet.
- Exact Vercel pricing, profit margin, or private protocol reproduction.
- A promise that users can simply wrap any Lambda and receive savings.

## Success Criteria

- Streaming is visible end to end, not represented only by a synthetic final
  response.
- No logical request is lost during fragmented frames, reconnect, nack,
  timeout, or worker drain.
- Worker count responds to latency and resource pressure instead of a hard
  request-to-worker ratio.
- Idle workers eventually return so AWS invocation-duration billing stops.
- Benchmark data proves its displayed totals and separates AWS cost from the
  Vercel explanatory model.
- Documentation states where this reconstruction differs from Vercel.

## Milestones

1. **Local mechanism:** fixed local workers prove the protocol, fibers, and
   streamed responses.
2. **AWS worker:** one Lambda worker connects to a remote orchestrator.
3. **Pool behavior:** dynamic admission, scale-out trigger, drain, and
   scale-down.
4. **Benchmark:** conventional baseline, burst, sustained traffic, idle tail.
5. **Article/demo:** architecture, traces, measurements, and limitations.

The fixed worker count in milestone 1 is a test fixture. It is not the final
scaling model.
