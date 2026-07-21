import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const infraDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(infraDirectory, "../..");
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1] : "builder";
const exampleArgument = args.find(
  (argument, index) => !argument.startsWith("--") && index !== profileIndex + 1
);

if (exampleArgument === undefined) {
  console.error("Usage: pnpm demo:local-aws <example.ts> [--profile builder]");
  process.exit(1);
}

const examplePath = resolve(repositoryRoot, exampleArgument);
if (!existsSync(examplePath)) {
  console.error(`Benchmark example not found: ${examplePath}`);
  process.exit(1);
}

const generatedDirectory = resolve(infraDirectory, ".generated");
const generatedEntrypoint = resolve(generatedDirectory, "lambda-worker.ts");
const exampleImport = relative(generatedDirectory, examplePath).replaceAll("\\", "/");
const normalizedImport = exampleImport.startsWith(".")
  ? exampleImport
  : `./${exampleImport}`;

mkdirSync(generatedDirectory, { recursive: true });
writeFileSync(
  generatedEntrypoint,
  [
    'import { makeLambdaWorkerHandler } from "@lambda-fluid/aws-runtime";',
    `import definition from ${JSON.stringify(normalizedImport)};`,
    "",
    "export const handler = makeLambdaWorkerHandler(definition.handler);",
    "export default handler;",
    "",
  ].join("\n")
);

const run = (commandArgs, extraEnvironment = {}) => {
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: infraDirectory,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
  });
  if (result.signal !== null) process.kill(process.pid, result.signal);
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(["./scripts/alchemy-aws.mjs", "deploy", "--profile", profile, "--yes"], {
  LAMBDA_FLUID_WORKER_MAIN: "./.generated/lambda-worker.ts",
});

run([
  "./scripts/alchemy-aws.mjs",
  "runtime",
  "node",
  "../../dist/demo-local-aws/demo-local-aws.js",
  examplePath,
  "--profile",
  profile,
]);
