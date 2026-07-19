import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/alchemy-aws.mjs <alchemy-command> [args...]");
  process.exit(1);
}

const profileIndex = args.findIndex((arg) => arg === "--profile");
const profile =
  profileIndex >= 0 && args[profileIndex + 1] ? args[profileIndex + 1] : "default";
const credentialsPath = join(homedir(), ".alchemy", "credentials", profile, "aws.json");

if (!existsSync(credentialsPath)) {
  console.error(
    `Alchemy AWS credentials for profile '${profile}' were not found. Run: pnpm infra:login --profile ${profile}`
  );
  process.exit(1);
}

const credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
const env = {
  ...process.env,
  AWS_ACCESS_KEY_ID: credentials.accessKeyId,
  AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  AWS_REGION: credentials.region ?? process.env.AWS_REGION ?? "us-east-1",
  CI: "true",
};

if (credentials.sessionToken) {
  env.AWS_SESSION_TOKEN = credentials.sessionToken;
}

if (!env.AWS_ACCOUNT_ID) {
  const identity = spawnSync(
    "aws",
    ["sts", "get-caller-identity", "--output", "json"],
    { encoding: "utf8", env }
  );

  if (identity.status !== 0) {
    console.error("Failed to resolve AWS account id with stored credentials.");
    console.error((identity.stderr || identity.stdout).trim());
    process.exit(identity.status ?? 1);
  }

  env.AWS_ACCOUNT_ID = JSON.parse(identity.stdout).Account;
}

const alchemy = spawnSync("alchemy", [command, ...args], {
  stdio: "inherit",
  env,
});

process.exit(alchemy.status ?? 1);
