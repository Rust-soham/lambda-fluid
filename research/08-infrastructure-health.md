# Infrastructure Health

Checked on 2026-06-24. These checks were read-only; no cloud resources were
created, changed, or destroyed.

## AWS Lambda

| Check | Result | Evidence |
| --- | --- | --- |
| Surviving stored credential | valid | signed STS `GetCallerIdentity` returned HTTP 200 for the `builder` profile in `us-east-1` |
| Old smoke Lambda | absent | signed `GetFunction` configuration request for `lambda-fluid-smoke-aws` returned HTTP 404 |
| Root Alchemy stack | empty | `packages/infra/alchemy.run.ts` returns `{}` |
| Local Alchemy state | no active resource output | only `lambda-fluid-smoke-aws` state directory exists and its stack output is `{}` |
| Existing deploy wrapper | broken by default | it selects `default`, but only `builder` AWS credentials remain; it also requires an `aws` CLI that is not installed |

**Conclusion:** AWS credentials still work, but the old smoke Lambda does not
exist. There is no currently deployed Lambda resource that can be called
healthy.

## Fly.io

| Check | Result | Evidence |
| --- | --- | --- |
| Old app configuration | present locally | `packages/infra/smoke/fly/fly.toml` names `lambda-fluid-smoke` |
| Public endpoint | unavailable | `https://lambda-fluid-smoke.fly.dev` did not resolve via an external HTTPS probe |
| Fly authentication | unavailable | `flyctl auth whoami`, `status`, and `machines list` report no access token |
| Local deploy evidence | absent | local Fly logs/config contain no usable app deployment state |
| Suitability as orchestrator | unsuitable as written | config exposes only HTTP on 8080 and sets `min_machines_running = 0` with auto-stop |

**Conclusion:** the old Fly smoke app is not demonstrably deployed or healthy.
Even if the old app were restored, this HTTP scale-to-zero smoke configuration
is not a persistent TCP-orchestrator configuration.

## Required Reset

1. Make `builder` the explicit AWS profile or restore a `default` profile.
2. Replace the missing `aws` CLI dependency in `alchemy-aws.mjs`, or install and
   verify it before relying on that wrapper.
3. Deploy and invoke a fresh Lambda smoke function; check configuration, logs,
   and a real response.
4. Re-authenticate Fly if it remains the intended host.
5. Deploy a new orchestrator configuration with a TCP listener, authentication,
   TLS, and an explicit non-idle behavior suitable for persistent tunnels.
6. Record the fresh endpoint, app ID, Lambda ARN, region, deploy commit, and
   health-check command in this document.
