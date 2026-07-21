# Reference Architecture

## System Shape

```text
Load generator / client
        |
        | HTTP
        v
Persistent orchestrator
  - public request API
  - tunnel listener
  - worker registry
  - least-loaded router
  - pending request table
  - metrics and report service
        |
        | persistent outbound-initiated TCP tunnels
        v
AWS Lambda worker invocations
  - the application's worker bundle
  - frame decoder/encoder
  - bounded job fibers
  - process metrics sampler
  - heartbeat and health publisher
  - graceful drain
```

## Deployment Unit

**Decision:** one orchestrator installation owns one application worker pool.

Every worker runs the same application bundle and configuration. Application
identity is implicit in the programmer-owned installation, so it is not
repeated in job frames, worker registration, or orchestrator state. Hosting
multiple applications behind one orchestrator is a separate future
exploration because it requires authentication, isolation, quotas, fair
scheduling, and usage attribution.

The transcript alternates between:

1. three separately deployed Lambda functions; and
2. one Lambda function with three concurrent long-lived invocations.

Both can demonstrate the mechanism. One function with three invocations is
closer to a pool; three separate functions are simpler to identify and
provision deterministically. This remains an implementation decision to test.

## Startup Sequence

1. Provision or start the orchestrator.
2. Open its HTTP and tunnel listeners.
3. Provision the worker function.
4. Start the configured initial worker count.
5. Each invocation creates a unique `workerId`.
6. Each invocation opens an outbound connection to the orchestrator.
7. The worker sends a registration frame containing worker ID, protocol
   version, limits, and runtime metadata.
8. The orchestrator authenticates it and adds it to the registry.
9. The worker enters its receive loop and starts health and heartbeat fibers.
10. The benchmark waits until the expected ready-worker count is reached.

### Lambda invocation strategy

The worker starts as an asynchronous invocation and remains active while it
owns its tunnel. It returns only after drain or its safety deadline. The first
implementation uses the managed Node.js runtime and a normal handler; a custom
runtime and AWS Lambda Managed Instances are comparison work, not competing
v0 designs.

The tunnel protocol provides application-response streaming. Lambda response
streaming is a separate AWS feature and does not itself create in-function
concurrency.

## Request Sequence

1. The client submits a logical job to the orchestrator.
2. The HTTP fiber creates a request ID and a `Deferred`.
3. The router selects a healthy worker with capacity.
4. The pending table stores request ID to `Deferred`, selected worker, and
   deadline.
5. The orchestrator sends a job frame.
6. The worker validates the frame and performs an admission check.
7. The worker replies with accepted or nack.
8. An accepted job obtains a transactional permit and starts as a supervised
   child fiber.
9. Its CPU and I/O phases execute.
10. The worker sends a result or typed failure frame.
11. The orchestrator completes the matching `Deferred`.
12. The HTTP response returns and routing counters are updated.

## Packing and Scaling Are Concurrent Decisions

The orchestrator must optimize two goals at once:

1. preserve latency by providing enough parallel capacity;
2. reuse idle capacity inside already-running workers.

It must not use either extreme:

- "always start one Lambda invocation per incoming request"; or
- "force every request through a tiny fixed fleet regardless of queueing."

For each request, the router asks whether a connected worker can accept it
without exceeding CPU, memory, event-loop-lag, concurrency, lifetime, or
latency limits. If yes, it sends the request through that worker's existing
tunnel. If no suitable worker exists, the scaling layer starts another worker
invocation, subject to provider burst limits, and routes work when it
registers.

For a burst of 1,000 simultaneous requests:

- if no workers are warm, many new worker invocations may be required
  immediately to protect latency;
- the required number is not automatically 1,000, because each worker may
  accept more than one concurrent I/O-heavy request as soon as it registers;
- CPU-heavy requests may drive the number much closer to the request
  concurrency;
- I/O-heavy requests may need substantially fewer workers;
- provider scaling speed, configured per-worker concurrency, and latency
  targets determine the observed result.

In-function concurrency therefore applies to the initial burst as soon as
capacity exists. It is not restricted to requests arriving after the first
batch.

## Nothing Is Swapped Out of Lambda

When request A reaches an I/O boundary:

- request A remains suspended in the same worker process;
- its state remains in that process's heap;
- its network operation remains registered with the runtime;
- the worker's JavaScript thread becomes available for request B;
- request A resumes in the same worker when its I/O completes.

The tunnel does not move request A, replace a "part of the port," or transfer
its continuation to another Lambda. The tunnel lets the router send request B
to a worker whose runtime has available capacity.

## Orchestrator Services

### Tunnel listener

- accepts worker-initiated connections;
- performs registration and authentication;
- owns incremental frame decoders;
- starts one read loop and one serialized write path per connection;
- removes a worker when its scope closes.

### Worker registry

Stores immutable worker snapshots keyed by worker ID:

- connection handle;
- connection generation;
- in-flight count;
- max concurrency;
- health snapshot;
- last heartbeat;
- draining state;
- registration time.

Updates must replace maps or entries rather than mutate a shared `Map` in place
inside a `Ref`.

### Router

v0 routing policy:

1. filter to the requested deployment;
2. remove stale, draining, or unhealthy workers;
3. remove workers at concurrency capacity;
4. rank by in-flight count;
5. use health and event-loop lag as tie-breakers;
6. select deterministically or with bounded randomization;
7. retry another worker after nack.

The router must return a typed `NoCapacity` error rather than indexing an empty
array.

### Pending request table

Each entry contains:

- request ID;
- response `Deferred`;
- worker ID and connection generation;
- deadline;
- creation timestamp.

Entries must be removed on success, failure, timeout, disconnect, cancellation,
and shutdown.

### Billing and benchmark service

Stores raw observations rather than only totals:

- request timings;
- worker invocation intervals;
- process CPU samples;
- accepted and nacked jobs;
- queue delay;
- response latency;
- errors and timeouts;
- concurrency high-water marks.

Reports are derived from raw observations so formulas can be corrected without
rerunning the benchmark.

## Worker Fiber Tree

```text
Worker root scope
  |- tunnel connection scope
  |   |- frame read loop
  |   |- serialized write loop
  |   |- heartbeat loop
  |   `- reconnect supervisor
  |- health sampler
  |- drain signal
  |- transactional semaphore with N permits
  `- supervised job fibers
      |- job A
      |- job B
      `- job C
```

The root scope owns every child. A shutdown interrupts admission, waits for
in-flight jobs up to a deadline, flushes final metrics, and closes the socket.

## Admission and Backpressure

Unbounded fiber creation is not acceptable.

The worker has `maxConcurrency` permits. On a job frame:

- if draining, nack;
- if no permit is available, nack;
- if event-loop lag or memory crosses a threshold, nack;
- otherwise accept and run under one permit.

The orchestrator also maintains an upper bound on queued HTTP requests. When
the fleet is full it should reject quickly or wait within an explicit deadline.

The concurrency setting is workload-dependent. The transcript's
`1 / cpuFraction` estimate is only a starting heuristic for a stable I/O-heavy
workload, not a universal formula.

## Health Model

Suggested worker snapshot:

```text
workerId
timestamp
inFlight
maxConcurrency
processCpuDelta
memoryRss
heapUsed
  eventLoopLag
  openFileDescriptors / fd count (where available)
accepted
nacked
draining
```

Sampling every 200 ms was discussed as an analogy to Vercel, not a verified
requirement. Make the interval configurable and measure its overhead.

## Reconnection

The connection policy must handle:

- orchestrator restart;
- orchestrator host restart;
- NAT or load-balancer timeout;
- transient DNS failure;
- half-open connection;
- duplicate registration after reconnect.

Use exponential backoff with jitter and a cap. Every reconnect increments a
connection generation so late results from an old socket cannot complete a new
request with the same worker identity.

The worker invocation may exit if the orchestrator remains unavailable beyond
a configured budget. Infinite reconnect inside a billed Lambda invocation can
be expensive.

The transcript also suggests a heartbeat every few seconds. Heartbeat interval,
health interval, TCP keepalive, and stale-worker timeout are separate settings.

## Graceful Drain

Drain sequence:

1. mark worker draining;
2. stop accepting new jobs;
3. notify orchestrator;
4. wait for all transactional permits to return;
5. force-timeout remaining jobs at the drain deadline;
6. send final metrics;
7. close tunnel;
8. return from the Lambda invocation.

Do not rely on receiving an OS signal in every Lambda lifecycle. Invocation
deadline and orchestrator-driven drain must also be supported.

## Scaling Boundary

The project has two layers:

- **local mechanism tests:** use a fixed worker count so frame, fiber, and
  drain behavior are deterministic;
- **reference architecture:** try connected healthy capacity first, reroute on
  nack, start another worker when no worker can meet the request deadline, and
  retire excess workers after idle grace.

This does not attempt Vercel's multi-region compute resolver. It does implement
the central pack-and-scale decision in one orchestrator.

## Idle Scale-Down

The production model should not retain worker invocations indefinitely when
there is no demand.

A later pool manager needs:

1. a minimum desired warm count, which may be zero;
2. a last-use timestamp per worker;
3. an idle grace period to avoid cold-start thrashing;
4. a drain command that stops new admission;
5. completion or timeout of in-flight jobs;
6. return from the outer Lambda invocation;
7. removal of the closed tunnel from the registry.

AWS can retire an execution environment after an invocation finishes, but a
Lambda Fluid worker whose outer invocation intentionally stays open will not
become idle from AWS's perspective until the worker returns. The harness must
therefore implement its own idle decision and end the invocation.

Local tests use fixed workers only for determinism. The live benchmark includes
worker startup, scale-out, request execution, idle tail, drain, and teardown in
its AWS cost report.

## Security Boundary

At minimum:

- TLS for remote tunnel traffic;
- short-lived worker credentials;
- credentials bound to the application-owned orchestrator installation;
- frame size limits;
- schema validation;
- request deadlines;
- no secrets in logs;
- no arbitrary code upload;
- one application worker bundle per worker process;
- explicit outbound network policy for real use.

Effect scopes and fibers improve lifecycle safety. They do not isolate malicious
code, memory, environment variables, or CPU.
