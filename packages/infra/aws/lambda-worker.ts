import { makeLambdaWorkerHandler } from "@lambda-fluid/aws-runtime";
import { syntheticHandler } from "@lambda-fluid/benchmark";

export const handler = makeLambdaWorkerHandler(syntheticHandler);

// Alchemy's current diff bundler expects a default-compatible external entry.
export default handler;
