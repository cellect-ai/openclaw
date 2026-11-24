import { expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { testing } from "./subagent-announce-delivery.test-support.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";

const TARGET_KEY = "agent:cellect-fi-user:matrix:channel:!room:example.org";
const SOURCE_KEY = "hook:fi-shadow:bf888001";

it("passes the requester agent into direct delivery when several agents are configured", async () => {
  const cfg: OpenClawConfig = {
    agents: {
      list: [{ id: "cellect-fi-user" }, { id: "cellect-fi-admin" }, { id: "cellect-main" }],
    },
  };
  const dispatch = vi.fn(async (...args: Parameters<typeof dispatchGatewayMethodInProcess>) => {
    args[2]?.onAccepted?.({ status: "accepted" });
    return { status: "ok" };
  });
  testing.setDepsForTest({
    getRuntimeConfig: () => cfg,
    dispatchGatewayMethodInProcess: dispatch,
    loadRequesterSessionEntry: (key) => ({
      cfg,
      canonicalKey: key,
      agentId: "cellect-fi-user",
      entry: { sessionId: "matrix-session", updatedAt: 1 },
    }),
    getRequesterSessionActivity: () => ({ sessionId: "matrix-session", isActive: false }),
  });
  onTestFinished(() => testing.setDepsForTest());

  await sendSubagentAnnounceDirectly({
    requesterSessionKey: TARGET_KEY,
    requesterAgentId: "cellect-fi-user",
    targetRequesterSessionKey: TARGET_KEY,
    triggerMessage: "shadow result",
    expectsCompletionMessage: false,
    directIdempotencyKey: "shadow-direct-owner",
    directOrigin: { channel: "matrix", to: "!room:example.org", accountId: "fi-user" },
    requesterSessionOrigin: { channel: "matrix", to: "!room:example.org", accountId: "fi-user" },
    sourceSessionKey: SOURCE_KEY,
    sourceTool: "subagent_announce",
    requesterIsSubagent: false,
  });

  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
    agentId: "cellect-fi-user",
    sessionKey: TARGET_KEY,
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: SOURCE_KEY,
      sourceTool: "subagent_announce",
    },
  });
});
