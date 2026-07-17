# Billing and Benchmarking

## Purpose

The benchmark must demonstrate concurrency and cost mechanics without inventing
Vercel's internal economics.

It should answer:

1. How much logical work completed?
2. How many Lambda invocations were active?
3. How long was each invocation billed?
4. How much aggregate process CPU was consumed?
5. How much request time was waiting rather than executing?
6. What changed versus a conventional Lambda baseline?

## Required Measurements

### Per request

- request ID;
- worker ID;
- orchestrator receive time;
- route time;
- worker accept time;
- execution start and end;
- wall-clock duration;
- queue delay;
- explicitly measured synchronous CPU phases;
- I/O interval;
- outcome.

### Per worker

- invocation start and end;
- first and last job;
- jobs accepted, completed, failed, nacked;
- peak and average in-flight jobs;
- process CPU delta over the worker interval;
- event-loop lag samples;
- memory samples;
- reconnects and disconnects.

### Fleet

- number of active worker invocations;
- sum of billed invocation duration;
- sum of process CPU time;
- total jobs and throughput;
- utilization;
- queueing and latency percentiles;
- orchestrator resource use.

## Correct Aggregations

Let:

- `R` be completed logical requests;
- `W` be workers;
- `requestWall[r]` be each request's wall duration;
- `workerBilled[w]` be each worker invocation's billed duration;
- `workerCpu[w]` be process CPU consumed by that worker;
- `memoryGb[w]` be configured memory;
- `lambdaRate` be AWS GB-second price input;
- `activeCpuRate` be the explanatory active CPU rate input;
- `memoryRate` be any explanatory provisioned-memory rate input.

Then:

```text
sumRequestWall = sum(requestWall[r] for r in R)
fleetBilledMs = sum(workerBilled[w] for w in W)
fleetCpuMs = sum(workerCpu[w] for w in W)

baselineLambdaCost =
  sum(baselineBilledMs[r] * baselineMemoryGb[r] * lambdaRate)

multiplexedAwsCost =
  sum(workerBilled[w] * memoryGb[w] * lambdaRate)

idealizedActiveCpuCharge =
  allocatedVcpuActiveMs * activeCpuRate
  + inFlightMemoryGbMs * memoryRate
  + logicalInvocationCount * invocationRate

fleetCpuUtilization =
  fleetCpuMs / fleetBilledMs
```

If two vCPUs can execute simultaneously, aggregate CPU time can exceed elapsed
wall time. Utilization must state whether its denominator is one CPU, allocated
vCPU capacity, or billed worker time.

Vercel defines Active CPU as allocated vCPUs multiplied by actively used time.
Its current pricing documentation says provisioned memory is charged while the
instance has in-flight work and stops after the last in-flight request
completes; invocations count incoming function requests.

That customer-facing memory interval is not automatically the same as this
demo's AWS worker invocation interval. A worker that remains alive waiting for
future tunnel jobs can continue generating AWS duration cost even when there
are no logical jobs. Measure and report that idle tail separately.

## Critical Corrections

### Do not sum request wall time as fleet billed time

Fifty overlapping 220 ms requests can have about 11,000 ms of summed request
wall time while completing in a much smaller fleet interval.

### Do not assume three workers each live only one request duration

If workers were started before the benchmark and stay alive afterward, their
actual billed invocation interval includes warm-up, idle time, and teardown.
Measure it.

### Do not call every logical job a Lambda invocation

In the harness, many jobs travel inside one active Lambda invocation.

### Do not derive Vercel margin

Unknown inputs include:

- Vercel's AWS commercial agreement;
- infrastructure beyond Lambda;
- exact memory and CPU allocation;
- regional costs;
- platform overhead;
- request, memory, bandwidth, and plan pricing;
- idle fleet strategy.

The transcripts' 92.6% break-even and 6.5% margin figures are superseded
hypotheticals, not research conclusions.

### Do not imply cross-customer worker sharing

Vercel's density is in-function concurrency for one function's code. Router
infrastructure is shared; customer code environments are isolated.

## CPU Attribution

Use two complementary measurements:

### Aggregate worker CPU

Read `process.cpuUsage()` at worker interval boundaries. This captures process
CPU including runtime overhead and is the best fleet-level measure available
in pure Node.js.

### Explicit phase CPU

For the synthetic job, measure only synchronous CPU blocks. Because JavaScript
cannot interleave another callback in the middle of one synchronous function,
the delta is attributable enough for demonstration.

Do not wrap the entire asynchronous request in `process.cpuUsage()` and assign
the delta to that request. Concurrent requests would each count CPU performed
while they were waiting.

## Benchmark Baselines

### Baseline A: conventional Lambda

- same worker code or equivalent handler;
- one Lambda invocation per benchmark request;
- same memory and region;
- same CPU and I/O workload;
- concurrency high enough to avoid artificial serial queueing;
- collect reported and billed duration.

### Baseline B: local process

- same multiplexer and protocol locally;
- removes AWS and cross-network variability;
- validates correctness and scheduler behavior.

### Candidate C: Lambda Fluid

- configured initial worker count plus measured scale-out and idle retirement;
- logical jobs routed through tunnels;
- bounded in-function concurrency;
- same workload and memory.

### Optional D: AWS Lambda Managed Instances

AWS now offers managed in-environment concurrency for Node.js. Comparing it
with the custom tunnel can clarify what the project builds itself versus what
AWS can provide as a product.

## Workload Matrix

Do not publish one cherry-picked run. Sweep:

- CPU fraction: 5%, 20%, 50%, 90%;
- I/O latency: 20, 100, 250, 1,000 ms;
- worker concurrency: 1, 4, 8, 16, 32, 64;
- worker count: 1, 3, 10;
- traffic: one burst and sustained stream;
- payload size;
- success, timeout, and error rates.

For each cell record throughput, p50/p95/p99 latency, queue delay, CPU,
memory, nacks, and cost inputs.

## Continuous Traffic

The transcripts correctly notice that a one-shot batch does not represent a
busy service. Add a sustained test:

1. warm the configured initial fleet;
2. send a controlled arrival rate for several minutes;
3. increase rate until latency or nacks rise;
4. find useful saturation;
5. measure the idle tail after traffic ends.

This exposes both the density benefit and the cost of retained workers.

The phrase "the CPU is never idle" is a goal at useful saturation, not a
guarantee. Too little traffic leaves workers idle; too much traffic creates
queueing and tail-latency collapse.

## Burst Interpretation

Do not benchmark Fluid concurrency by assuming that a burst of `N` requests
must first create `N` Lambda invocations.

The comparison needs an explicit latency policy:

- conventional baseline: provider creates enough concurrent environments for
  the burst, subject to scaling limits;
- multiplexed candidate: reuse healthy worker capacity and create additional
  workers whenever packing more requests would violate the latency policy.

Report:

- workers warm before the burst;
- workers created during the burst;
- jobs accepted per worker;
- time spent waiting for a worker registration;
- time spent waiting for a worker permit;
- first-byte and completion latency.

This reveals the actual tradeoff. More workers reduce queueing but reduce
packing efficiency; fewer workers improve density but can increase latency.
The goal is not the smallest possible worker count. It is the smallest fleet
that satisfies the latency objective.

## Pricing Inputs

All rates must be configuration with:

- provider;
- region;
- memory;
- architecture;
- retrieval date;
- source URL;
- units.

Never hard-code transcript examples such as `$0.0000000167/ms/GB` without
checking current official pricing and units.

Vercel's public pricing separates active CPU, provisioned memory, and
invocations. A fair explanatory model includes all three, not only active CPU.

For the self-hosted harness, also include:

- cold-start and worker-registration time;
- between-job idle time while the outer invocation remains open;
- idle scale-down grace period;
- drain and teardown time.

## Report Shape

```text
SETUP
  workload, traffic model, region, memory, worker count, concurrency

PER REQUEST
  wall, explicit CPU phases, I/O/wait, queue, worker, outcome

PER WORKER
  billed interval, process CPU, jobs, peak in-flight, utilization, nacks

FLEET
  completed work, elapsed interval, summed billed duration, aggregate CPU

BASELINE COMPARISON
  conventional Lambda versus multiplexed harness

IDEALIZED ACTIVE-CPU VIEW
  parameterized CPU + memory + invocation charge

LIMITATIONS
  measurement semantics, unknown provider economics, variance
```

The report should show percentages, but never round tiny values so aggressively
that costs appear to be zero or savings exceed what the raw data supports.

## Verification Tests

- totals equal the sum of raw records;
- idle estimate never silently goes negative;
- percentages are in valid ranges or explain multi-vCPU values;
- currency conversion preserves units;
- request overlap does not inflate fleet duration;
- baseline and candidate use the same workload;
- failed requests are not omitted;
- rounding occurs only at presentation;
- formulas are property-tested with generated observations.
