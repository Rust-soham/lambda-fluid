# Understanding benchmark output

## Example workloads

`01-order.ts` sends 30 instances of one order request:

```text
5 ms CPU -> 200 ms abort-aware wait -> 5 ms CPU -> three chunks
```

`02-three-endpoints.ts` sends ten requests to each of three endpoints with
different CPU and I/O profiles. It demonstrates that workers execute an
ordinary routed application handler rather than a special benchmark opcode.

## Local report

The local CLI compares two models on the same machine:

- conventional: one independent environment interval per request;
- Fluid: logical requests share fewer worker intervals.

It is an architectural duration model, not an AWS bill prediction.

## AWS report

In Mode 2:

- the Fluid side runs through real AWS Lambda workers;
- the conventional side remains a local baseline model;
- worker intervals begin before invocation launch and end at batch completion;
- cold-start and tunnel-establishment time are included;
- post-batch idle tail, GB-second weighting, and invocation charges are not.

The columns are not yet a production cost comparison. The conventional side has
no AWS network or cold start, while Fluid travels from the laptop through a
Quick Tunnel to AWS and back.

## Why one cold burst can lose

A recent 30-request run showed roughly:

```text
normal modeled duration       6.4 seconds
Fluid worker intervals       16.9 seconds
Fluid workers                 4
```

Four outer invocations each spent several seconds starting and registering
before a roughly one-second batch. Multiplexing reduced environment count from
30 to 4, but one short burst did not amortize startup.

That is an important result:

> Fluid execution needs warm reuse across sustained traffic. Starting several
> long-running workers solely for one short burst can cost more than conventional
> Lambda.

## Metrics supported today

- request count and HTTP success;
- worker invocations launched;
- peak logical load observed per worker;
- local or end-to-end batch wall time;
- environment-count reduction;
- the exact topology named by the report.

## Claims not yet supported

- production AWS cost savings;
- apples-to-apples conventional AWS latency;
- warm steady-state break-even;
- post-batch Lambda idle tail;
- production orchestrator-to-Lambda latency.

The next benchmark milestone is to run conventional and Fluid paths in AWS,
separate cold and warm bursts, and measure a sustained traffic window through a
region-local orchestrator.
