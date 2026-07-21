# Delivery Roadmap

## 1. Local Protocol And State Core

Complete and test the pure model before adding runtime or infrastructure:

- worker registration and health schemas;
- reservations, accept, nack, suppression, and snapshot reconciliation;
- atomic fleet selection and reservation;
- starting-worker capacity claims;
- typed no-capacity and transition failures.

## 2. Local Streaming Core

Build and test locally before AWS:

- versioned length-prefixed frame decoder and encoder;
- worker registration and authentication placeholder;
- response-start, body-chunk, and response-end flow;
- one reader and serialized writer per tunnel;
- one orchestrator and multiple local worker processes;
- traces proving requests interleave at I/O boundaries.

## 3. Local Pool Control

Add:

- bounded in-worker concurrency;
- health snapshots and nack;
- latency-aware packing decision;
- worker-registration deadline;
- reconnect generation;
- drain and idle-retirement state machine.

This stage can use a fixed number of local processes to validate mechanics.

## 4. Re-establish Infrastructure

Use [Infrastructure Health](./08-infrastructure-health.md) as the starting
point. Do not build on the old smoke resources.

- repair the AWS profile selection and remove the dependency on a missing AWS
  CLI from the wrapper;
- deploy a fresh Lambda smoke function and prove invoke/log/config health;
- select and configure a persistent orchestrator host only after the local
  tunnel works;
- configure TLS/authentication and a warm policy suitable for worker tunnels.

## 5. AWS Worker

Deploy one real worker that opens an outbound tunnel and returns after drain.
Then validate:

- startup and registration;
- request/response streaming;
- concurrent I/O-heavy jobs;
- timeout behavior;
- invocation duration and process CPU observation;
- graceful return before Lambda timeout.

## 6. Pack-and-Scale

Implement the production-shaped decision path:

1. route to safe connected capacity;
2. retry another worker on nack;
3. start another worker when no suitable worker can meet the latency target;
4. wait only to the request deadline for registration/capacity;
5. retire excess workers after idle grace and drain.

The initial scale policy can be simple, but it must be measured rather than
hard-coded as one request equals one worker or one fixed pool handles all work.

## 7. Benchmark

Run matched workloads through:

- conventional Lambda baseline;
- Lambda Fluid burst run;
- Lambda Fluid sustained run;
- idle scale-down run.

Persist raw observations, configuration, region, memory, git commit, and
pricing source date. Render only derived reports from those artifacts.

## 8. Publish

The article and README should lead with:

1. streaming origin;
2. reverse connection;
3. in-function concurrency;
4. pack-and-scale behavior;
5. idle retirement;
6. real benchmark results;
7. exact limits of the reconstruction.
