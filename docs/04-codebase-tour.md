# Codebase tour

## Top-level composition

| Path                          | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `src/main.ts`                 | Interactive all-local composition root           |
| `src/modes/local-aws.ts`      | Interactive local orchestrator to one AWS worker |
| `src/modes/demo-local-aws.ts` | Finite example-driven AWS benchmark              |
| `src/quick-tunnel.ts`         | Scoped development-only public tunnel adapter    |
| `examples/`                   | Trusted application handlers and request plans   |
| `docs/`                       | Current implementation and evaluation guide      |
| `research/`                   | Historical research and design derivation        |

Composition roots assemble packages with Effect layers. Domain behavior belongs
inside workspace packages.

## Workspace packages

### `@lambda-fluid/protocol`

Owns branded identities, job and lifecycle schemas, response frames, JSON
codecs, four-byte length framing, and the pure incremental decoder.

Read: `schema/tunnel.ts` -> `framing.ts` -> `tunnel-codec.ts`.

### `@lambda-fluid/tunnel`

Turns an Effect Socket into a typed bidirectional Channel while retaining pure
decoder state and transport backpressure.

Read: `src/channel.ts`.

### `@lambda-fluid/worker`

Owns transactional final admission, `FiberMap` job supervision, abort-aware
handler execution, bounded response queues, cancellation, drain, and tunnel
session composition.

Read: `runtime.ts` -> `job-handler.ts` -> `tunnel-session.ts`.

### `@lambda-fluid/orchestrator`

Owns immutable worker transitions, Pack/Spread ranking, STM-backed selection and
reservation, connection registration, response correlation, HTTP translation,
and adaptive local launch decisions.

Read: `worker-state.ts` -> `fleet-state.ts` -> `fleet-registry.ts` ->
`control-plane.ts`.

### `@lambda-fluid/aws-runtime`

Owns the generic Lambda handler adapter, invocation schemas, scoped outer
invocation launcher, platform-neutral `WorkerInvoker`, and the direct AWS
implementation for non-Alchemy hosts.

Read: `worker-invoker.ts` -> `launcher.ts` -> `lambda-handler.ts`.
Distilled imports are confined to `direct-worker-invoker.ts`.

### `@lambda-fluid/benchmark`

Defines the trusted example contract and demonstration handlers. Workload values
are report metadata; workers execute ordinary handlers.

### `@lambda-fluid/benchmark-cli`

Loads TypeScript examples, drives finite workloads, and renders reports.

### `@lambda-fluid/infra`

Owns the Alchemy AWS stack, Lambda bundling, local credential bridge, generated
example entrypoint, and Mode 2 command orchestration.

## Tests by invariant

| Test                                          | Evidence                                             |
| --------------------------------------------- | ---------------------------------------------------- |
| `protocol/test/framing.test.ts`               | fragmented, coalesced, empty, oversized frames       |
| `tunnel/test/channel.test.ts`                 | schemas and framing compose bidirectionally          |
| `tunnel/test/tcp.test.ts`                     | real TCP preserves complete frames                   |
| `worker/test/runtime.test.ts`                 | concurrency, admission, streaming, cancellation      |
| `orchestrator/test/worker-state.test.ts`      | reservations, stale snapshots, suppression, recovery |
| `orchestrator/test/fleet-state.test.ts`       | Pack/Spread ranking and nack directives              |
| `orchestrator/test/control-plane.test.ts`     | end-to-end routing and correlation                   |
| `orchestrator/test/adaptive-capacity.test.ts` | launch claims and traffic hysteresis                 |

## Claims-to-evidence matrix

| Claim                                             | Source seam                                             | Verification                    |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| selection and reservation are atomic              | `fleet-registry.ts`                                     | fleet/control-plane tests       |
| worker is final admission authority               | `worker/src/worker-state.ts`                            | worker runtime tests            |
| concurrent jobs are keyed and supervised          | `worker/src/runtime.ts`                                 | worker runtime tests            |
| TCP read boundaries do not equal frame boundaries | `protocol/src/framing.ts`                               | framing and TCP tests           |
| responses preserve status, headers, and chunks    | `worker/src/job-handler.ts`, `orchestrator/src/http.ts` | control-plane test and examples |
| AWS launcher is adapter-independent               | `aws-runtime/src/worker-invoker.ts`                     | TypeScript dependency boundary  |
| selected handler executes in Lambda               | `infra/scripts/run-example.mjs`                         | Mode 2 live command             |
