import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  installDelegationFixtures,
  mintBody,
  mints,
  plugin,
  SANDBOXED,
  slackThread,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();

const writer = "/workspace/skills/shared-shape-mail/scripts/mail-state.mjs";
const installed =
  "/repos/fi-runtime/fi/skills/tenants/shape/shared-shape-mail/scripts/mail-state.mjs";
const args =
  "begin --custody-file /workspace/.work/mail/custody.json --message-id abc123 --thread-id def456 --slack-root 1793813662.241269 --retry-failed true";

it.each([`node ${writer}`, `/repos/fi-runtime/node ${installed}`])(
  "binds the linked Slack requester's mail checkpoint to immutable code: %s",
  async (entry) => {
    const turn = plugin();
    const slack = slackThread();
    await turn.arrive(slack.arrive);
    await turn.start(slack.start);
    const result = await turn.exec(slack.exec, { params: { command: `${entry} ${args}` } });
    expect(result?.params).toMatchObject({
      host: "sandbox",
      elevated: false,
      closeProcessTree: true,
      env: { FI_DELEGATED_USER_TOKEN: TOKEN, FI_APP_URL: "https://fi.example.test/fi" },
    });
    const argv = execFileSync(
      "/bin/sh",
      ["-c", `set -- ${result?.params.command}; printf '%s\\0' "$@"`],
      { encoding: "utf8" },
    )
      .split("\0")
      .slice(0, -1);
    expect(argv).toEqual(["/repos/fi-runtime/node", installed, ...args.split(" ")]);
    expect(mintBody()).toEqual({ requesterSenderId: "U0ADMIN001", agentId: "cellect-fi-admin" });
  },
);

it("preserves quoted checkpoint evidence without executing expansions", async () => {
  const turn = plugin();
  await turn.arrive();
  await turn.start();
  const literal = "Alex's HVAC (Unit 2); literal $HOME and $(env)\nnext line";
  const escaped = `'${literal.replaceAll("'", "'\\''")}'`;
  const result = await turn.exec(
    {},
    {
      params: { command: `node ${writer} status --failure-reason ${escaped}` },
    },
  );
  expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(TOKEN);
  const argv = execFileSync(
    "/bin/sh",
    ["-c", `set -- ${result?.params.command}; printf '%s\\0' "$@"`],
    { encoding: "utf8" },
  )
    .split("\0")
    .slice(0, -1);
  expect(argv).toEqual([
    "/repos/fi-runtime/node",
    installed,
    "status",
    "--failure-reason",
    literal,
  ]);
});

it.each([
  `node -r /workspace/inject.cjs ${writer} ${args}`,
  `node --eval 'process.env' ${writer}`,
  `node /workspace/custom/mail-state.mjs ${args}`,
  `node ${writer}.backup ${args}`,
  `node ${writer}/../mail-state.mjs ${args}`,
  `node ${writer} ${args}; env`,
  `node ${writer} ${args} > /workspace/result`,
  `node ${writer} ${args} $(env)`,
  `NODE_OPTIONS=--inspect node ${writer} ${args}`,
  `node ${writer} ${args}\nenv`,
])("withholds credentials from an unmaintained or composed writer: %s", async (command) => {
  const turn = plugin();
  await turn.arrive();
  await turn.start();
  const result = await turn.exec({}, { params: { command } });
  expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
  expect(mints()).toHaveLength(0);
});

it("does not turn caller environment into a maintained writer command", async () => {
  const turn = plugin();
  await turn.arrive();
  await turn.start();
  const result = await turn.exec(
    {},
    {
      params: {
        command: `node ${writer} ${args}`,
        env: { NODE_OPTIONS: "--require=/workspace/x" },
      },
    },
  );
  expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
  expect(mints()).toHaveLength(0);
});

it("does not mint for the mail writer without an immutable runtime bind", async () => {
  const host = {
    ...SANDBOXED,
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          docker: {
            binds: [
              "/fixture/cli:/usr/local/bin/cellect:ro",
              "/fixture/runtime:/repos/fi-runtime:rw",
            ],
          },
        },
      },
    },
  };
  const turn = plugin({}, host);
  await turn.arrive();
  await turn.start();
  const result = await turn.exec({}, { params: { command: `node ${writer} ${args}` } });
  expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
  expect(mints()).toHaveLength(0);
});

it("cannot recover a settled requester's authority by naming their old thread", async () => {
  const turn = plugin();
  const slack = slackThread();
  await turn.arrive(slack.arrive);
  await turn.start(slack.start);
  await turn.settle();
  const result = await turn.exec(slack.exec, { params: { command: `node ${writer} ${args}` } });
  expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
  expect(mints()).toHaveLength(0);
});
