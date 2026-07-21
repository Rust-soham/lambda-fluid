# Agent orientation

Read `README.md`, then `docs/README.md`. Treat `docs/08-current-status.md` as the
claims boundary: do not describe partially implemented behavior as complete.

## Safe first commands

```bash
pnpm check
pnpm test
pnpm bench examples/01-order.ts
```

The benchmark is finite and local. AWS commands mutate external state and may
cost money; only run them when explicitly requested.

## Architecture invariants

- One orchestrator manages one application worker pool; there is no active
  multi-tenant `deploymentId` model.
- Public clients speak HTTP. Internal request, attempt, worker, and frame fields
  do not cross the client response boundary.
- The orchestrator owns routing estimates and reservations. The worker owns the
  final transactional admission decision and may nack.
- Selection plus reservation must stay atomic through STM.
- Application handlers are ordinary TypeScript functions bundled into workers;
  executable code is never sent over the tunnel.
- Distilled AWS imports belong only in the direct external-host adapter. The
  launcher depends on the project-owned `WorkerInvoker` service.
- Expected failures remain typed Effect values. Do not introduce `any`, unsafe
  casts, or exception-driven application control flow.

## Navigation

- Wire schemas and framing: `packages/protocol`
- Socket Channels: `packages/tunnel`
- Worker concurrency: `packages/worker`
- Fleet and routing: `packages/orchestrator`
- Lambda adapter and invocation capability: `packages/aws-runtime`
- Application examples: `examples`
- Composition roots: `src`
- Alchemy deployment: `packages/infra`

Use package-local source imports such as `effect/Effect`, not aggregate imports
from `effect`. Keep composition roots thin and domain behavior in packages.
