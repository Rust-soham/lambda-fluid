# Documentation navigator

This folder is the judge-facing and agent-facing map of Lambda Fluid. It explains
what can be run, what each result proves, and where the corresponding
implementation lives.

## Five-minute evaluation

```bash
pnpm install
pnpm check
pnpm test
pnpm bench examples/01-order.ts
pnpm bench examples/02-three-endpoints.ts
```

These commands exercise the complete local HTTP, routing, framed tunnel, worker
concurrency, streaming response, and adaptive fleet path.

If AWS credentials and `cloudflared` are available:

```bash
pnpm demo:local-aws examples/01-order.ts --profile builder
```

## Reading paths

### Run the project

1. [Mode 1: local end to end](02-mode-1-local.md)
2. [Mode 2: local orchestrator to AWS](03-mode-2-local-aws.md)
3. [Understanding benchmark output](07-benchmarking.md)

### Understand the architecture

1. [System architecture](01-architecture.md)
2. [Protocol and request lifecycle](05-protocol-and-lifecycle.md)
3. [Routing, admission, and scaling](06-routing-and-scaling.md)

### Inspect and judge the implementation

1. [Codebase tour](04-codebase-tour.md)
2. [Current guarantees and limitations](08-current-status.md)

## Terminology

| Term             | Meaning in this project                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| Lambda function  | AWS deployment definition containing the worker adapter and application handler     |
| Outer invocation | One long-running AWS invocation that owns a worker tunnel                           |
| Worker           | Runtime inside one outer invocation                                                 |
| Logical request  | Application request sent through the tunnel; AWS does not see a separate invocation |
| Orchestrator     | HTTP boundary, fleet registry, router, correlator, and worker launcher              |
| Tunnel           | Persistent bidirectional connection between one worker and the orchestrator         |
| Reservation      | Orchestrator-owned capacity claim made atomically before dispatch                   |

## Truth hierarchy

1. Tests and checked-in source establish behavior.
2. `docs/` explains the current implementation.
3. `research/` records design derivation and future direction.

When source and an old research ambition differ, source and these docs win.
