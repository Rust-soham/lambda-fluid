# Current guarantees and limitations

This file is the claims boundary for reviewers and coding agents.

## Demonstrated

- Two finite local examples with 30 concurrent requests.
- One handler routes multiple HTTP endpoints.
- Client HTTP is translated into a typed internal protocol.
- Length-prefixed framing survives fragmented and coalesced TCP reads.
- Multiple logical jobs execute concurrently in one worker process.
- Worker admission is transactional and can nack stale routing decisions.
- Fleet selection plus reservation is atomic across request fibers.
- Pack and Spread rank safe workers differently.
- Status, headers, and body chunks return through the orchestrator.
- Example handlers are bundled and executed in real AWS Lambda workers.
- A real run packed 30 logical requests into four outer invocations and reached
  eight in-flight requests per worker.

## Partially implemented

- Health schemas include CPU, memory, event-loop lag, and in-flight evidence,
  but AWS workers currently send initial health rather than periodic samples.
- Nack transitions produce retry or disconnect directives, but the live control
  plane does not execute the retry decision tree.
- Adaptive launch and Pack/Spread hysteresis run locally; the AWS benchmark
  precomputes workers from its known batch.
- Workers understand drain and invocation deadlines, but warm-fleet replacement
  and idle scale-down are not connected end to end.

## Deliberately out of scope

- multi-tenant code pools and billing isolation;
- arbitrary language runtimes;
- sending executable code through the tunnel;
- production authentication and TLS identity design;
- exact reconstruction of Vercel's private implementation.

## Development constraints

- Mode 2 uses an ephemeral Quick Tunnel because Lambda cannot dial laptop
  loopback.
- A Mode 2 process can remain alive briefly after printing the report while
  synchronous invocations and upgraded sockets close.
- Alchemy is beta and has produced noisy Lambda update diffs; the stack sets
  `url: false` explicitly to avoid an earlier replacement issue.
- Mode 2 leaves its Lambda deployed until `infra:destroy` runs.

## Verification

```bash
pnpm check
pnpm test
pnpm format:check
git diff --check
```

Tests focus on state and transport invariants rather than mocks. See the
[codebase test map](04-codebase-tour.md#tests-by-invariant).
