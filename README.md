# Lambda Fluid

Lambda Fluid is an Effect-based reconstruction of the core idea behind fluid
serverless compute: keep a Lambda invocation alive as a worker, send multiple
logical HTTP requests through one outbound tunnel, and let the Node.js event
loop execute another request while earlier requests await I/O.

This is an OSS prototype and developer tool, not a hosted multi-tenant service.
One orchestrator manages one application and one compatible worker pool.

## Quick evaluation

Install and verify:

```bash
pnpm install
pnpm check
pnpm test
```

### Mode 1: completely local

No cloud credentials are needed. These finite commands exercise the client,
HTTP orchestrator, adaptive fleet, TCP tunnels, workers, and streamed responses.

```bash
pnpm bench examples/01-order.ts
pnpm bench examples/02-three-endpoints.ts
```

### Mode 2: local orchestrator to AWS Lambda

This bundles the chosen example handler into an Alchemy-managed Lambda, starts a
temporary public worker ingress, and routes the same 30-request workload through
real Lambda workers.

```bash
pnpm infra:login --profile builder
pnpm demo:local-aws examples/01-order.ts --profile builder
pnpm demo:local-aws examples/02-three-endpoints.ts --profile builder
```

Mode 2 requires `cloudflared`, creates or updates AWS resources, and can incur
charges. Read the setup and cleanup guide before running it.

## Judge and agent guide

Start with the [documentation navigator](docs/README.md). It includes:

- a five-minute evaluation path;
- architecture and request-flow diagrams;
- both supported execution modes;
- a package-by-package source tour;
- protocol, concurrency, routing, and lifecycle explanations;
- benchmark interpretation;
- an explicit implemented-versus-incomplete matrix.

The shortest source-reading path is:

1. [`examples/01-order.ts`](examples/01-order.ts) — ordinary application code.
2. [`packages/orchestrator/src/control-plane.ts`](packages/orchestrator/src/control-plane.ts) — routing and response correlation.
3. [`packages/worker/src/runtime.ts`](packages/worker/src/runtime.ts) — concurrent logical jobs.
4. [`packages/tunnel/src/channel.ts`](packages/tunnel/src/channel.ts) — bidirectional framed transport.
5. [`packages/aws-runtime/src/lambda-handler.ts`](packages/aws-runtime/src/lambda-handler.ts) — Lambda adapter.

## Scope

The supported evaluation surface is deliberately limited to:

1. fully local end-to-end execution;
2. a local orchestrator controlling AWS Lambda workers.

`research/` preserves the reasoning and source research that led here; `docs/`
describes what the checked-in implementation does now.
