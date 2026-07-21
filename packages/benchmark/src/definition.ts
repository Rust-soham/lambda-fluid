import type {
  ApplicationRequest,
  RetrySafety,
  SyntheticWorkload,
} from "@lambda-fluid/protocol";
import type { JobHandler } from "@lambda-fluid/worker";

export interface BenchmarkRequest {
  readonly name: string;
  readonly request: ApplicationRequest;
  readonly workload: SyntheticWorkload;
  readonly retrySafety: RetrySafety;
}

export interface BenchmarkDefinition {
  readonly name: string;
  readonly description: string;
  readonly requests: ReadonlyArray<BenchmarkRequest>;
  readonly handler: JobHandler;
}

/** Gives example files contextual typing without hiding their ordinary handler. */
export const defineBenchmark = (definition: BenchmarkDefinition): BenchmarkDefinition =>
  definition;

export const isBenchmarkDefinition = (input: unknown): input is BenchmarkDefinition => {
  if (typeof input !== "object" || input === null) return false;
  if (!("name" in input) || typeof input.name !== "string") return false;
  if (!("description" in input) || typeof input.description !== "string") {
    return false;
  }
  if (!("requests" in input) || !Array.isArray(input.requests)) return false;
  return "handler" in input && typeof input.handler === "function";
};
