# Protocol and Data Model

## Design Principles

1. Define schemas before service implementations.
2. Keep the wire contract independent of the Node implementation details.
3. Make every state transition explicit.
4. Treat TCP as a byte stream, not a message transport.
5. Validate before dispatch.
6. Bound every length, queue, deadline, and concurrency value.
7. Preserve raw measurements so reports are reproducible.

## Transport

v0 uses a length-prefixed binary envelope containing a JSON payload:

```text
4 bytes unsigned big-endian payload length
N bytes UTF-8 JSON payload
```

This is intentionally simple for the project's TCP learning objective and its
Node.js worker.

A production protocol may later use MessagePack, CBOR, protobuf, or another
binary format. Changing encoding must not change the domain message model.

## Required Frame Union

### Connection control

- `RegisterWorker`
- `RegisterAccepted`
- `RegisterRejected`
- `Heartbeat`
- `HealthSnapshot`
- `BeginDrain`
- `DrainComplete`
- `ProtocolError`

### Job lifecycle

- `JobRequest`
- `JobAccepted`
- `JobNack`
- `JobResult`
- `JobFailed`
- `CancelJob`

### Streaming lifecycle

- `RequestBodyChunk`
- `RequestEnd`
- `ResponseStarted`
- `ResponseBody` / `ResponseBodyChunk`
- `ResponseEnd`

Streaming is part of the first protocol design because it is central to the
Vercel architecture. The earliest local test may use a one-chunk response, but
it must exercise `ResponseStarted`, one or more body chunks, and `ResponseEnd`.

## Core Schemas

Conceptual model:

```text
RegisterWorker
  protocolVersion
  deploymentId
  workerId
  runtime: "nodejs"
  maxConcurrency
  startedAt
  authToken

JobRequest
  requestId
  deploymentId
  sentAt
  deadline
  workload

SyntheticWorkload
  cpuIterations or targetCpuMs
  ioDelayMs or fetchUrl
  secondCpuIterations or targetCpuMs

JobResult
  requestId
  workerId
  receivedAt
  startedAt
  completedAt
  queueDelayMs
  wallClockMs
  measuredCpuUs
  outcome

HealthSnapshot
  workerId
  timestamp
  inFlight
  maxConcurrency
  eventLoopLagMs
  processCpuUsSinceLastSample
  rssBytes
  heapUsedBytes
  draining
```

Use integer microseconds and bytes in the wire model where practical. Convert
to rounded milliseconds only in presentation.

## Schema-First Effect Model

The transcript correctly insists that domain types and codecs come from Effect
Schema rather than parallel TypeScript interfaces plus unchecked
`JSON.parse`.

Implementation rules:

- define a discriminated union for frames;
- infer decoded TypeScript types from schemas;
- validate numeric ranges and string lengths;
- represent decode failures as typed protocol errors;
- keep envelope framing errors separate from payload schema errors;
- version the protocol from the first frame.

Exact API spelling must follow Effect `4.0.0-beta.98` installed in this repo.
The transcript's `ServiceMap.Service` examples are not current for this
workspace.

## Incremental Decoder

TCP may deliver:

- half a header;
- a header plus half a payload;
- several complete frames in one chunk;
- a frame split across many chunks.

Each connection owns a private buffer:

1. append incoming bytes;
2. if fewer than four bytes, wait;
3. parse payload length;
4. reject zero or over-limit lengths;
5. if the full payload is unavailable, wait;
6. slice one payload;
7. retain trailing bytes;
8. decode and dispatch;
9. repeat until no complete frame remains.

Never call the payload decoder directly on a raw `data` event and assume it is
one frame.

## Serialized Writes

Concurrent job fibers can finish at the same time. Socket writes need one
serialized path so frame bytes are not interleaved.

Recommended shape:

- job fibers enqueue complete encoded frames;
- one writer fiber drains the queue;
- queue capacity is bounded;
- socket backpressure is honored;
- writer failure closes the connection scope and fails affected jobs.

## Correlation and State

`requestId` correlates all frames for one logical job.

The orchestrator owns the authoritative request state:

```text
Created -> Routed -> Accepted -> Completed
                  \-> Nacked -> Routed
                  \-> Failed
Created/Routed/Accepted -> TimedOut
Any nonterminal state -> Cancelled
```

Only one terminal transition may complete the `Deferred`. Duplicate or late
results are logged and ignored.

## Registration

The first worker frame must be `RegisterWorker`. Registration binds:

- socket to worker ID;
- worker ID to deployment ID;
- negotiated protocol version;
- concurrency limit;
- credentials;
- connection generation.

Do not infer worker identity from the first `JobResult`, as some transcript
sketches do.

## Nack Semantics

`JobNack` should contain a reason:

- `AtCapacity`
- `Draining`
- `HighCpu`
- `HighEventLoopLag`
- `HighMemory`
- `DeadlineTooClose`
- `UnsupportedWorkload`
- `Internal`

The router may retry another worker for retryable reasons. It must preserve the
original request deadline and cap retry attempts.

## Error Model

Suggested tagged errors:

- `FrameTooLarge`
- `FrameDecodeError`
- `UnsupportedProtocolVersion`
- `AuthenticationFailed`
- `UnknownDeployment`
- `NoHealthyWorkers`
- `WorkerDisconnected`
- `JobNacked`
- `JobTimedOut`
- `JobFailed`
- `PendingRequestMissing`
- `SocketWriteFailed`
- `SocketReadFailed`

Business logic should allow these to accumulate in Effect's error channel.
HTTP status mapping, retry, logging, and final reporting belong at system
boundaries.

## Node Worker Boundary

The initial protocol has one supported worker: Node.js with Effect. The
orchestrator and worker still communicate only through schema-validated frames,
which keeps the boundary clean without pretending that multi-language support
is part of this project's scope.

The canonical requirements are incremental framing, bounded buffering, one
serialized writer, typed dispatch, and streaming lifecycle frames.

## Per-Worker Versus Shared Tunnels

**Decision:** one physical tunnel per worker invocation.

Many request IDs share that tunnel. This gives:

- natural worker lifecycle ownership;
- connection-level failure isolation;
- simple capacity accounting;
- no need to multiplex different worker processes onto one socket;
- clean Effect `Scope` ownership.

It is not one tunnel per request. One worker owns one connection and runs many
logical request streams over it.

## Future Protocol Work

- binary payloads if JSON becomes a bottleneck;
- cancellation acknowledgement;
- idempotency keys;
- resume after reconnect;
- trace context propagation;
- worker capability metadata needed by the scaler.
