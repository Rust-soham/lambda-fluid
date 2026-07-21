# Effect Design

## Role of Effect

Effect is the control plane inside Lambda Fluid. It makes the worker and
orchestrator lifecycles explicit:

- schemas define frames and configuration before implementation;
- services define registry, router, pending requests, connections, metrics,
  and scaling boundaries;
- fibers represent supervised logical requests;
- scopes own listeners, sockets, samplers, and worker drain;
- layers swap local and AWS adapters;
- typed errors flow to the HTTP and process boundaries.

## Canonical Primitive Map

| Primitive                  | Responsibility                                           |
| -------------------------- | -------------------------------------------------------- |
| `Schema`                   | protocol, config, benchmark artifact validation          |
| `Context.Service`          | service contracts in the installed Effect beta           |
| `Layer`                    | local, test, and AWS composition                         |
| `STM` / `TxRef`            | atomic fleet selection, reservation, and worker state    |
| `Deferred`                 | one client request waiting for one remote terminal frame |
| `Queue`                    | bounded admission and serialized socket writes           |
| `TxSemaphore`              | transactional in-worker permits and drain completion     |
| `Effect.forkScoped`        | supervised request and subsystem fibers                  |
| `Scope` / `acquireRelease` | connection and server ownership                          |
| `Schedule`                 | reconnect, heartbeat, health sample, idle decision       |
| timeout/race               | request deadline and drain deadline                      |

## Fiber Rules

- Each accepted logical request is a supervised child fiber.
- A child that awaits I/O yields the Node event loop; it is not a separate OS
  thread or Lambda instance.
- Synchronous JavaScript still blocks every fiber on that event-loop thread.
- The worker root scope owns child fibers, connection, health loop, and writer.
- Use `Effect.run*` only at host entry points, never for detached work per
  decoded frame.

## Service Boundaries

```text
ProtocolCodec
TunnelServer / TunnelConnector
WorkerRegistry
PendingRequests
Router
WorkerHealth
WorkerScaler
ObservationStore
ReportRenderer
```

Business flow belongs in `Effect.gen`: select worker, register pending result,
send frame, await terminal result, record observation. Retry, timeout, logging,
and HTTP error mapping wrap that flow at the boundary.

## Test Composition

Use Layer replacement rather than callback mocking for the core model:

- an in-memory tunnel adapter;
- deterministic clock and IDs;
- scripted worker behavior: accept, nack, delay, disconnect, corrupt frame;
- capturing observations;
- no-op or test logger.

Tests must prove fragmented framing, nack retry, pending cleanup, drain,
reconnect generation, scaling decision, idle retirement, and benchmark totals.

## Current API Constraint

This repository currently uses Effect `4.0.0-beta.98`. The transcript snippets
span earlier prerelease APIs and are not source code. Follow installed types:

- `Context.Service` for service declarations;
- `Schema.Schema.Type` for decoded types;
- `TxSemaphore` for permits that compose atomically with admission and drain
  state;
- current unstable socket and HTTP modules where appropriate.
