# Primary Sources

## Vercel

- [Fluid: How we built serverless servers](https://vercel.com/blog/fluid-how-we-built-serverless-servers)
  - Function Router, compute resolver, Rust core, secure TCP-based protocol,
    streaming, resource metrics, nack, and in-function concurrency.
- [How Fluid compute works on Vercel](https://vercel.com/blog/how-fluid-compute-works-on-vercel)
  - product and routing overview.
- [Serverless servers: Node.js with in-function concurrency](https://vercel.com/blog/serverless-servers-node-js-with-in-function-concurrency)
  - concurrency motivation and Node.js behavior.
- [Introducing Active CPU pricing for Fluid compute](https://vercel.com/blog/introducing-active-cpu-pricing-for-fluid-compute)
  - active CPU pricing terminology.
- [Vercel function usage and pricing](https://vercel.com/docs/functions/usage-and-pricing)
  - active CPU, provisioned memory, and invocation terms.

## AWS Lambda

- [Understanding Lambda function scaling](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html)
  - conventional invocation concurrency and execution environments.
- [Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/runtimes-open-source.html)
  - runtime API context.
- [Lambda Managed Instances runtime](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-nodejs-runtime.html)
  - AWS's own in-environment concurrency comparison point.

## Project Tooling

- [Effect documentation](https://effect.website/docs/)
- [Effect v4 beta release notes](https://effect.website/blog/releases/effect/40-beta/)
- [Alchemy repository](https://github.com/alchemy-run/alchemy)

The installed Effect and Alchemy package declarations are authoritative for
implementation API shape. The transcript is not.
