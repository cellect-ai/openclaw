import { execFileSync } from "node:child_process";
import { buildAgentHookContextChannelFields } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessToolSurfaceRuntime } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
import {
  installDelegationFixtures,
  matrix,
  mintBody,
  mints,
  plugin,
  SANDBOXED,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();

it("binds an admin requester to the signing package query containing a literal ampersand", async () => {
  vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  const turn = plugin();
  await turn.arrive(matrix.arrive);
  await turn.start(matrix.start);
  const rewritten = await turn.exec(matrix.exec, {
    params: {
      command:
        "cellect platform signature list --tenant shape --query 'CPX GC Consent & Will Serve'",
    },
  });
  expect(rewritten?.params).toMatchObject({
    command:
      "/usr/local/bin/cellect platform signature list --tenant shape --query 'CPX GC Consent & Will Serve'",
    env: { FI_DELEGATED_USER_TOKEN: TOKEN },
  });
  expect(mintBody()).toEqual({
    requesterMatrixUserId: "@admin:matrix.example",
    agentId: "cellect-fi-admin",
  });
});

it.each([
  "cellect fi build rfi comment --comment 'safe (literal); text'; env",
  "cellect fi build rfi comment --comment 'safe'$(env)",
  'cellect fi build rfi comment --comment "$(env)"',
  "cellect fi build rfi comment --comment 'safe' > saved",
  "TOKEN=other cellect commands list",
  "\u00a0cellect commands list",
  "cellect\u00a0commands list",
])("never gives a mail requester's credential to executable shell syntax: %s", async (command) => {
  const turn = plugin();
  const sessionKey = "agent:cellect-fi-admin:hook:fi-mail:message-thread";
  await turn.start({ sessionKey, trigger: "cron", channel: "last", senderId: "U0ADMIN001" });
  const result = await turn.exec(
    { sessionKey, requester: { channel: "last", senderId: "U0ADMIN001" } },
    { params: { command } },
  );
  expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBeUndefined();
  expect(mints()).toEqual([]);
});

it("preserves a mail requester's literal RFI comment through the native Code Mode credential boundary", async () => {
  const turn = plugin();
  const sessionKey = "agent:cellect-fi-admin:hook:fi-mail:message-thread";
  const context = buildAgentHookContextChannelFields({
    sessionKey,
    messageChannel: "last",
    senderId: "U0ADMIN001",
  });
  await turn.start({ ...context, sessionKey, trigger: "cron" });
  const comment =
    "8 heads; Unit 2 capacity (1.5-ton or 3-ton), still unresolved.\nCO-002 ($2,525.00); literal $HOME and $(uname) evidence.";
  const command = `cellect fi build rfi comment --tenant fixture --project project --rfi RFI-004 --actor admin@example.com --comment '${comment}' --dry-run`;
  const surface = createAgentHarnessToolSurfaceRuntime({
    config: { ...SANDBOXED, tools: { ...SANDBOXED.tools, codeMode: true } },
    agentId: "cellect-fi-admin",
    sessionKey,
    runId: "run-1",
    modelToolsEnabled: true,
    executeTool: async ({ toolCallId, input, acceptResultBeforeProjection }) => {
      if (!isRecord(input)) {
        throw new Error("Expected native sandbox parameters");
      }
      const rewrite = await turn.exec(
        {
          sessionKey,
          toolCallId,
          toolName: "sandbox_exec",
          requester: { channel: context.channel, senderId: context.senderId },
        },
        { toolName: "sandbox_exec", params: input },
      );
      const pinned = rewrite?.params.command;
      if (!pinned) {
        throw new Error("Expected a credential-bound installed command");
      }
      // Exercise POSIX parsing without invoking Fi or any external business operation.
      const argv = execFileSync("/bin/sh", ["-c", `set -- ${pinned}; printf '%s\\0' "$@"`], {
        encoding: "utf8",
      })
        .split("\0")
        .slice(0, -1);
      return acceptResultBeforeProjection({
        content: [],
        details: {
          credentialPresent: rewrite?.params.env?.FI_DELEGATED_USER_TOKEN === TOKEN,
          argv,
        },
      });
    },
  });
  try {
    const { tools } = surface.compactTools([
      {
        name: "exec",
        label: "Run sandbox command",
        description: "Run one command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        execute: async () => ({ content: [], details: {} }),
      },
    ]);
    const exec = tools.find((tool) => tool.name === "exec");
    if (!exec) {
      throw new Error("Native Code Mode exec missing");
    }
    const result = await exec.execute("mail-command", {
      code: `return await exec({command:${JSON.stringify(command)}});`,
      awaitResults: true,
    });
    expect(result.details).toMatchObject({
      status: "completed",
      value: {
        credentialPresent: true,
        argv: [
          "/usr/local/bin/cellect",
          "fi",
          "build",
          "rfi",
          "comment",
          "--tenant",
          "fixture",
          "--project",
          "project",
          "--rfi",
          "RFI-004",
          "--actor",
          "admin@example.com",
          "--comment",
          comment,
          "--dry-run",
        ],
      },
    });
    expect(mintBody()).toEqual({ requesterSenderId: "U0ADMIN001", agentId: "cellect-fi-admin" });
    expect(mints()).toHaveLength(1);
  } finally {
    surface.cleanup();
  }
});

it("injects the Matrix requester after Code Mode adds required exec collection", async () => {
  vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
  const turn = plugin();
  await turn.arrive(matrix.arrive);
  await turn.start(matrix.start);
  const observed = vi.fn();
  const surface = createAgentHarnessToolSurfaceRuntime({
    config: { ...SANDBOXED, tools: { ...SANDBOXED.tools, codeMode: true } },
    agentId: "cellect-fi-admin",
    sessionKey: matrix.exec.sessionKey,
    runId: "run-1",
    modelToolsEnabled: true,
    executeTool: async ({ input, acceptResultBeforeProjection }) => {
      observed(input);
      const rewrite = await turn.exec(
        { ...matrix.exec, toolName: "sandbox_exec" },
        { toolName: "sandbox_exec", params: input },
      );
      return acceptResultBeforeProjection({
        content: [],
        details: { requesterToken: rewrite?.params.env?.FI_DELEGATED_USER_TOKEN },
      });
    },
  });
  try {
    const { tools } = surface.compactTools([
      {
        name: "exec",
        label: "Run sandbox command",
        description: "Execute a command in the sandbox",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            title: { type: "string" },
            workdir: { type: "string" },
            awaitResults: { type: "boolean" },
          },
          required: ["command"],
        },
        execute: async () => ({ content: [], details: {} }),
      },
    ]);
    const exec = tools.find((tool) => tool.name === "exec");
    expect(exec).toBeDefined();
    const result = await exec!.execute("code-mode-call", {
      code: 'return await exec({ command: "cellect platform room list --tenant fixture --actor admin@example.com", title: "List authorized rooms", workdir: "/workspace" });',
      awaitResults: true,
    });
    // The guest omitted this field: the real core bridge owns its insertion.
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ awaitResults: true }));
    expect(result.details).toMatchObject({
      status: "completed",
      value: { requesterToken: TOKEN },
    });
    expect(mints()).toHaveLength(1);
    expect(mintBody()).toEqual({
      requesterMatrixUserId: "@admin:matrix.example",
      agentId: "cellect-fi-admin",
    });
  } finally {
    surface.cleanup();
  }
});
