# Lambda Fluid Research

This directory is the project reference for **Lambda Fluid**: a Vercel
Fluid-Compute-inspired reconstruction on AWS Lambda.

It is intentionally not a transcript archive. The source conversations remain
under `.agents/transcripts/`; this directory keeps only the decisions and facts
that shape the project.

## Project Scope

Lambda Fluid studies how Vercel uses a bidirectional connection to support
streaming responses, in-function concurrency, resource-aware routing, and
active-CPU pricing on top of AWS Lambda.

The project will build a smaller, observable version of the first three:

1. A worker Lambda invocation opens an outbound persistent connection to an
   orchestrator.
2. The orchestrator sends logical HTTP requests and receives streamed response
   frames over that connection.
3. A worker runs multiple I/O-heavy requests concurrently in the same Node.js
   process.
4. The router packs work into healthy workers and scales out when that would
   otherwise violate latency or resource limits.
5. Idle workers drain and return from their outer Lambda invocation.

The project measures AWS-billed worker duration and CPU behavior. It does not
claim to change AWS billing into Vercel's Active CPU pricing.

Cloudflare is retained only as a short architectural comparison in
[Vercel Fluid Compute](./02-runtime-foundations.md). It is not an
implementation target, separate demo, hosting choice, or product direction.

## Canonical Decisions

- **Primary inspiration:** Vercel Fluid Compute, especially the streaming and
  in-function concurrency architecture.
- **Runtime:** Node.js with Effect v4.
- **Protocol:** a versioned, bidirectional, length-prefixed frame protocol that
  models streaming from the start.
- **Scheduling:** latency-first packing and scale-out, not a fixed minimum
  worker count.
- **I/O behavior:** a waiting request remains suspended in the same worker;
  the tunnel delivers new work to available capacity.
- **Scale-down:** explicit drain and return from the outer Lambda invocation.
- **Benchmark:** compare conventional Lambda with the harness using matched
  workload, then present Vercel pricing only as a separately parameterized
  explanatory model.
- **Initial deliverable:** a reference implementation and measured demo, not a
  production SDK.

## Documents

1. [Project Charter](./01-project-charter.md)
2. [Vercel Fluid Compute](./02-runtime-foundations.md)
3. [Reference Architecture](./03-reference-architecture.md)
4. [Protocol and Data Model](./04-protocol-and-data-model.md)
5. [Effect Design](./05-effect-design.md)
6. [Billing and Benchmarking](./06-billing-and-benchmarking.md)
7. [Delivery Roadmap](./07-delivery-roadmap.md)
8. [Infrastructure Health](./08-infrastructure-health.md)
9. [Primary Sources](./primary-sources.md)

## Current Infrastructure Status

The old smoke resources are **not healthy foundations** for the project:

- the surviving AWS credential path is valid, but the named smoke Lambda no
  longer exists;
- the old Fly hostname does not resolve, Fly authentication is unavailable,
  and its configuration is HTTP-only with scale-to-zero behavior;
- the root Alchemy stack currently provisions no resources.

See [Infrastructure Health](./08-infrastructure-health.md) for the exact
evidence and date.
