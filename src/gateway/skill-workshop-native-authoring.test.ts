import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createConfiguredSkillWorkshopTool } from "../agents/tools/skill-workshop-tool-factory.js";
import { prepareReplyWorkshopAuthoring } from "../auto-reply/reply/reply-workshop-authoring.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { createCommandOwnerTestGateway } from "../channels/message-access/operator-authority.test-support.js";
import { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import * as workspaceWrites from "../skills/lifecycle/workspace-skill-write.js";
import { inspectSkillProposal, listSkillProposals } from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { resolveSkillWorkshopToolConstructionBlock } from "../skills/workshop/tool-availability.js";
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
  const gateway = createCommandOwnerTestGateway(cfg);
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
    workspaceDir: stateDir,
    config: cfg,
    agentId: "main",
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

it("uses the actual sandbox Workshop factory without a person profile and never edits managed skills", async () => {
  await fixture(async (f) => {
    expect(
      resolveSkillWorkshopToolConstructionBlock({ sandboxed: true, workspaceAuthoring: f.cap }),
    ).toBeUndefined();
    const managed = path.join(f.stateDir, "skills", "managed", "SKILL.md");
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.writeFile(managed, "Managed role procedure\n");
    const created = await f.execute({
      action: "create",
      name: "my-procedure",
      description: "Reusable own procedure",
      proposal_content: "# My procedure\nFollow this procedure.\n",
      support_files: [{ path: "references/check.txt", content: "verified\n" }],
    });
    const details = created.details;
    if (
      !isRecord(details) ||
      typeof details.id !== "string" ||
      typeof details.revisionHash !== "string"
    ) {
      throw new Error("Expected proposal receipt");
    }
    expect(details.id).toBeTruthy();
    await f.execute({
      action: "apply",
      proposal_id: details.id,
      expected_revision_hash: details.revisionHash,
    });
    expect(
      await fs.readFile(path.join(f.root, "my-procedure", "references/check.txt"), "utf8"),
    ).toBe("verified\n");
    const read = await f.execute({ action: "read", skill_name: "my-procedure" });
    expect(JSON.stringify(read)).toContain("Follow this procedure");
    await expect(
      f.execute({
        action: "update",
        skill_name: managed,
        description: "No",
        proposal_content: "# Changed\n",
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
        if (String(args[0]).includes("skill-workshop")) {
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
            description: "Must not publish",
            proposal_content: "# Never\nNever published.\n",
          }),
        ).rejects.toThrow();
      } finally {
        mkdir.mockRestore();
      }
      await expect(fs.access(path.join(f.root, "revoked-procedure", "SKILL.md"))).rejects.toThrow();
      expect((await listSkillProposals({ config: f.cfg, agentId: "main" })).proposals).toEqual([]);
    }, kind === "group");
  },
);

it("restores exact applied files and pending metadata when authority closes before the store commit", async () => {
  await fixture(async (f) => {
    const created = await f.execute({
      action: "create",
      name: "commit-fenced",
      description: "Reusable procedure",
      proposal_content: "# Original\nOriginal procedure.\n",
    });
    const details = created.details;
    if (
      !isRecord(details) ||
      typeof details.id !== "string" ||
      typeof details.revisionHash !== "string"
    ) {
      throw new Error("Expected proposal receipt");
    }
    const apply = workspaceWrites.applyWorkspaceSkillMutation;
    const write = vi
      .spyOn(workspaceWrites, "applyWorkspaceSkillMutation")
      .mockImplementation(async (...args) => {
        await apply(...args);
        f.retire();
      });
    try {
      await expect(
        f.execute({
          action: "apply",
          proposal_id: details.id,
          expected_revision_hash: details.revisionHash,
        }),
      ).rejects.toThrow("no longer current");
    } finally {
      write.mockRestore();
    }
    await expect(fs.access(path.join(f.root, "commit-fenced", "SKILL.md"))).rejects.toThrow();
    const pending = await inspectSkillProposal(details.id, { config: f.cfg, agentId: "main" });
    expect(pending?.record.status).toBe("pending");
  });
});
