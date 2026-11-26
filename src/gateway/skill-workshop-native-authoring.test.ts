import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createConfiguredSkillWorkshopTool } from "../skills/workshop-host/skill-workshop-tool-factory.js";
import { prepareReplyWorkshopAuthoring } from "../auto-reply/reply/reply-workshop-authoring.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { createHostIngressFixture } from "../channels/message-access/host-ingress.test-support.js";
import { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { listWorkshopChanges } from "../skills/workshop-host/changes.js";
import * as workshopChanges from "../skills/workshop-host/changes.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop-host/skills-root.js";
import { resolveSkillWorkshopToolConstructionBlock } from "../skills/workshop-host/tool-availability.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

async function fixture(
  run: (f: Awaited<ReturnType<typeof nativeFixture>>) => Promise<void>,
  group = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await nativeFixture(state.stateDir, group);
    try {
      await run(f);
    } finally {
      f.close();
    }
  });
}
async function nativeFixture(stateDir: string, group: boolean) {
  const channelId = group ? "whatsapp" : "discord";
  const conversation = {
    kind: group ? ("group" as const) : ("direct" as const),
    id: group ? "team" : "conversation",
  };
  const sessionKey = group ? "agent:main:whatsapp:group:team" : "agent:main:discord:direct:100";
  const cfg: OpenClawConfig = {
    channels: group
      ? {
          whatsapp: {
            allowFrom: ["100"],
            groups: { team: { tools: { allow: ["skill_workshop"] } } },
          },
        }
      : { discord: { accounts: { team: { allowFrom: ["100"] } } } },
    agents: {
      entries: {
        main: {
          agentDir: path.join(stateDir, "agents/main/agent"),
          tools: {
            alsoAllow: ["skill_workshop"],
            sandbox: { tools: { alsoAllow: ["skill_workshop"] } },
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const { gateway } = createHostIngressFixture(channelId, cfg);
  let live = true;
  const owner = { channelId, isLive: () => live, resolveGatewayContext: () => gateway };
  const ingress = await createHostChannelIngressRuntime(owner).resolveStable({
    channelId,
    accountId: "team",
    identity: { authentication: "verified" },
    subject: { stableId: "100" },
    conversation,
    contextBinding: {
      agentId: "main",
      sessionKey,
      messageId: "message-1",
      inboundEventKind: "user_request",
    },
    dmPolicy: "allowlist",
    groupPolicy: group ? "open" : "disabled",
    allowFrom: ["100"],
    useDefaultPairingStore: false,
  });
  const context = await createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  )({
    channel: channelId,
    accountId: "team",
    messageId: "message-1",
    from: group ? "whatsapp:group:team" : "discord:100",
    sender: { id: "100" },
    conversation,
    route: { agentId: "main", routeSessionKey: sessionKey },
    reply: { to: group ? "whatsapp:group:team" : "discord:100" },
    ...(group ? { access: { toolPolicy: { allow: ["skill_workshop"] } } } : {}),
    message: { rawBody: "Improve your own Workshop procedure" },
    channelIngress: ingress,
  });
  const prepare = (ctx: MsgContext = context, freshHuman = true) =>
    prepareReplyWorkshopAuthoring(ctx, {
      agentId: "main",
      sessionKey,
      provider: "openai",
      model: "gpt-5.6-luna",
      freshHuman,
    });
  const cap = prepare();
  if (!cap) {
    throw new Error("Expected native explicit Workshop grant");
  }
  const runId = "workshop-native";
  registerAgentRunContext(runId, { agentId: "main", sessionKey });
  const admission = prepareSystemAgentRunAdmission(cfg, runId, "main", "test");
  const admitted = await admission.admit("embedded");
  cap.bind(admitted);
  const caller = {
    agentId: "main",
    sessionKey,
    operationalRunInstance: admitted.operationalRunInstance,
    receiptAuthority: () => true,
  };
  const tool = createConfiguredSkillWorkshopTool({
    config: cfg,
    agentId: "main",
    sessionKey,
    runId,
    sandboxed: true,
    run: { workspaceAuthoring: cap },
  });
  const execute = (input: unknown) =>
    withGatewayToolCallerIdentity(caller, () => tool.execute("test", input));
  return {
    cfg,
    cap,
    context,
    prepare,
    caller,
    tool,
    execute,
    close: admission.close,
    retire: () => {
      live = false;
    },
    root: resolveWorkshopSkillsDir(cfg, "main"),
    stateDir,
  };
}

it("reports committed file effects when change history acknowledgement fails", async () => {
  await fixture(async (f) => {
    const content =
      "---\nname: saved-procedure\ndescription: A saved procedure\n---\nRetain this procedure.\n";
    const failedJournal = vi
      .spyOn(workshopChanges, "recordWorkshopChange")
      .mockRejectedValueOnce(new Error("synthetic journal acknowledgement failure"));
    try {
      await expect(
        f.execute({ action: "create", name: "saved-procedure", content }),
      ).rejects.toThrow(
        'Skill "saved-procedure" files changed, but recording the change could not be confirmed.',
      );
      expect(await fs.readFile(path.join(f.root, "saved-procedure", "SKILL.md"), "utf8")).toBe(
        content,
      );
      expect(failedJournal).toHaveBeenCalledOnce();
      expect(await listWorkshopChanges("main", { runId: "workshop-native" })).toEqual([]);
    } finally {
      failedJournal.mockRestore();
    }
  });
});

it("uses the actual sandbox Workshop factory without a person profile and never edits managed skills", async () => {
  await fixture(async (f) => {
    expect(
      resolveSkillWorkshopToolConstructionBlock({ sandboxed: true, workspaceAuthoring: f.cap }),
    ).toBeUndefined();
    const managed = path.join(f.stateDir, "skills", "managed", "SKILL.md");
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.writeFile(managed, "Managed role procedure\n");
    await f.execute({
      action: "create",
      name: "my-procedure",
      content:
        "---\nname: my-procedure\ndescription: Reusable own procedure\n---\n# My procedure\nFollow this procedure.\n",
    });
    await f.execute({
      action: "write_file",
      name: "my-procedure",
      file_path: "references/check.txt",
      content: "verified\n",
    });
    expect(
      await fs.readFile(path.join(f.root, "my-procedure", "references/check.txt"), "utf8"),
    ).toBe("verified\n");
    const read = await f.execute({ action: "view", name: "my-procedure" });
    expect(JSON.stringify(read)).toContain("Follow this procedure");
    await expect(
      f.execute({
        action: "write_file",
        name: managed,
        file_path: "SKILL.md",
        content: "# Changed\n",
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(managed, "utf8")).toBe("Managed role procedure\n");
  });
});

it("requires the exact current grant, fresh opaque native ingress, and the matching live run", async () => {
  await fixture(async (f) => {
    expect(f.prepare({ ...f.context })).toBeUndefined();
    expect(f.prepare(f.context, false)).toBeUndefined();
    const agent = f.cfg.agents!.entries!.main!;
    agent.tools!.alsoAllow = ["*"];
    agent.tools!.sandbox!.tools!.alsoAllow = ["*"];
    expect(f.prepare()).toBeUndefined();
    await expect(f.execute({ action: "list" })).rejects.toThrow("no longer current");
    agent.tools!.alsoAllow = ["skill_workshop"];
    agent.tools!.sandbox!.tools!.alsoAllow = ["skill_workshop"];
    agent.tools!.deny = ["skill_workshop"];
    expect(f.prepare()).toBeUndefined();
    delete agent.tools!.deny;
    await expect(
      withGatewayToolCallerIdentity({ ...f.caller, agentId: "foreign" }, () =>
        f.tool.execute("test", { action: "list" }),
      ),
    ).rejects.toThrow("no longer current");
    await expect(f.tool.execute("test", { action: "list" })).rejects.toThrow("no longer current");
    f.close();
    await expect(f.execute({ action: "list" })).rejects.toThrow("no longer current");
  });
});

it.each(["owner", "policy", "group"])(
  "fences a native factory write after an awaited %s revocation",
  async (kind) => {
    await fixture(async (f) => {
      const realMkdir = fs.mkdir;
      const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        const result = await realMkdir(...args);
        if (String(args[0]).includes("workshop-skills")) {
          if (kind === "owner") {
            f.retire();
          } else if (kind === "group") {
            f.cfg.channels!.whatsapp!.groups!.team!.tools = { deny: ["skill_workshop"] };
          } else {
            f.cfg.agents!.entries!.main!.tools!.deny = ["skill_workshop"];
          }
        }
        return result;
      });
      try {
        await expect(
          f.execute({
            action: "create",
            name: "revoked-procedure",
            content:
              "---\nname: revoked-procedure\ndescription: Must not publish\n---\n# Never\nNever published.\n",
          }),
        ).rejects.toThrow();
      } finally {
        mkdir.mockRestore();
      }
      await expect(fs.access(path.join(f.root, "revoked-procedure", "SKILL.md"))).rejects.toThrow();
      expect(await listWorkshopChanges("main", { runId: "workshop-native" })).toEqual([]);
    }, kind === "group");
  },
);

it("restores the exact live copy when native publication loses authority between its renames", async () => {
  await fixture(async (f) => {
    const name = "commit-fenced";
    const content =
      "---\nname: commit-fenced\ndescription: Reusable procedure\n---\n# Original\nOriginal procedure.\n";
    await f.execute({ action: "create", name, content });
    await f.execute({
      action: "patch",
      name,
      old_text: "Original procedure.",
      new_text: "Changed procedure.",
    });
    const current = await fs.readFile(path.join(f.root, name, "SKILL.md"), "utf8");
    const changes = await listWorkshopChanges("main", { runId: "workshop-native" });
    const rename = fs.rename;
    const write = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      const result = await rename(...args);
      if (String(args[0]) === path.join(f.root, name) && String(args[1]).includes("-previous-")) {
        f.retire();
      }
      return result;
    });
    try {
      await expect(f.execute({ action: "restore", name })).rejects.toThrow("no longer current");
    } finally {
      write.mockRestore();
    }
    expect(await fs.readFile(path.join(f.root, name, "SKILL.md"), "utf8")).toBe(current);
    expect(await listWorkshopChanges("main", { runId: "workshop-native" })).toEqual(changes);
  });
});
