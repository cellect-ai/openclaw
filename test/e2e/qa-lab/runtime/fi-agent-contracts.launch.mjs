import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Test-local bootstrap: QA's auth/config readers run before the Gateway child
// environment is built. They must never see the caller's business credentials.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const smoke = process.argv.slice(2).includes("--smoke");
const outerSentinelKeys = [
  "FI_AGENT_CONTRACTS_OUTER_BUSINESS_SENTINEL",
  "FI_AGENT_CONTRACTS_OUTER_MODEL_SENTINEL",
];
if (smoke && outerSentinelKeys.some((name) => !process.env[name])) {
  throw new Error(
    "Composition smoke requires synthetic outer business/model sentinel keys before the bootstrap allowlist",
  );
}
const fixturePath = process.env.FI_AGENT_CONTRACTS_FIXTURE;
if (!fixturePath || !path.isAbsolute(fixturePath)) {
  throw new Error(
    "FI_AGENT_CONTRACTS_FIXTURE must name the pinned, credential-free builder fixture manifest",
  );
}
const fixtureBytes = await fs.readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes);
if (fixture.schemaVersion !== 1 || !fixture.evidenceDir || !fixture.sourceRevision) {
  throw new Error("Invalid Fi agent contract fixture manifest");
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "fi-agent-contracts-launch-"));
await fs.chmod(root, 0o700);
const directories = Object.fromEntries(
  ["home", "config", "data", "cache", "tmp"].map((name) => [name, path.join(root, name)]),
);
await Promise.all(
  Object.values(directories).map((directory) => fs.mkdir(directory, { mode: 0o700 })),
);
const launchEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: directories.home,
  XDG_CONFIG_HOME: directories.config,
  XDG_DATA_HOME: directories.data,
  XDG_CACHE_HOME: directories.cache,
  TMPDIR: directories.tmp,
  LANG: "C.UTF-8",
  CI: "1",
  FI_AGENT_CONTRACTS_BOOTSTRAP: randomUUID(),
  FI_AGENT_CONTRACTS_FIXTURE: fixturePath,
  FI_AGENT_CONTRACTS_FIXTURE_SHA256: createHash("sha256").update(fixtureBytes).digest("hex"),
  FI_AGENT_CONTRACTS_MODE: smoke ? "smoke" : "model",
};
let model;
if (smoke) {
  // This key is intentionally synthetic. The smoke verifies its admission to
  // the existing auth-profile owner and its absence everywhere else.
  launchEnv.OPENAI_API_KEY = "fi-agent-contracts-synthetic-model-credential";
} else {
  const modelPath = process.env.FI_AGENT_CONTRACTS_MODEL_CONFIG;
  if (!modelPath || !path.isAbsolute(modelPath)) {
    throw new Error(
      "FI_AGENT_CONTRACTS_MODEL_CONFIG must pin the existing API-key model service before inference",
    );
  }
  model = JSON.parse(await fs.readFile(modelPath, "utf8"));
  if (
    model.provider !== "openai" ||
    !model.model ||
    !model.version ||
    !["OPENAI_API_KEY", "OPENCLAW_LIVE_OPENAI_KEY"].includes(model.keyEnv)
  ) {
    throw new Error(
      "The existing model identity, version (or unknown) and selected API-key input must be explicit",
    );
  }
  const origin = new URL(model.baseUrl);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      "The pinned existing model service must use a credential-free HTTP(S) origin/path",
    );
  }
  const key = process.env[model.keyEnv];
  if (!key?.trim()) {
    throw new Error(`Selected model authority is unavailable: ${model.keyEnv}`);
  }
  launchEnv[model.keyEnv] = key;
  const selectedModelPath = path.join(root, "model.json");
  await fs.writeFile(selectedModelPath, JSON.stringify(model), { mode: 0o600 });
  launchEnv.FI_AGENT_CONTRACTS_MODEL_CONFIG = selectedModelPath;
}
const evidence = path.resolve(fixture.evidenceDir);
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
await fs.writeFile(
  path.join(evidence, `launch-${smoke ? "smoke" : fixture.comparison}.json`),
  JSON.stringify(
    {
      schemaVersion: 1,
      fixtureSha256: launchEnv.FI_AGENT_CONTRACTS_FIXTURE_SHA256,
      permittedParentKeys: Object.keys(launchEnv).toSorted(),
      excludedOuterKeys: [
        "FI_AGENT_CONTRACTS_OUTER_BUSINESS_SENTINEL",
        "FI_AGENT_CONTRACTS_OUTER_MODEL_SENTINEL",
      ],
      outerSentinelsPresentBeforeAllowlist: outerSentinelKeys.every((name) =>
        Boolean(process.env[name]),
      ),
      model: model
        ? { ...model, keyEnv: model.keyEnv }
        : { provider: "openai", model: "synthetic-smoke", inference: false },
      limits: {
        turnsPerFlow: 600,
        outputTokensPerFlow: 20000,
        outputTokensPerRequest: 2048,
        suiteTimeoutMs: 900000,
      },
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);

const child = spawn(
  process.execPath,
  [
    "--import",
    "./scripts/tsx.mjs",
    "scripts/test-live.mts",
    "--",
    "test/e2e/qa-lab/runtime/fi-agent-contracts.live.test.ts",
  ],
  { cwd: repoRoot, env: launchEnv, stdio: "inherit", detached: true },
);
let stopping = false;
const stop = (signal) => {
  if (stopping) {
    return;
  }
  stopping = true;
  if (child.pid) {
    process.kill(-child.pid, signal);
  }
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
// Do not remove isolated HOME until the native runner has joined its children.
if (result.code === 0) {
  await fs.rm(root, { recursive: true, force: true });
} else {
  process.stderr.write(`Failed fixture root retained for joined cleanup: ${root}\n`);
}
process.exitCode = result.code ?? 1;
