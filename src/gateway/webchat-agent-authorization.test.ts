import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isWebchatAgentAllowed,
  isWebchatSessionAllowed,
  resolveWebchatSessionAgentId,
} from "./webchat-agent-authorization.js";

const cfg = {
  agents: {
    list: [{ id: "fi-user", default: true }, { id: "fi-admin" }, { id: "cellect-superadmin" }],
  },
} as OpenClawConfig;

describe("webchat agent authorization", () => {
  it("preserves clients that do not carry an agent ceiling", () => {
    expect(isWebchatAgentAllowed(undefined, "fi-admin")).toBe(true);
    expect(
      isWebchatSessionAllowed({
        cfg,
        client: {},
        sessionKey: "agent:cellect-superadmin:slack:direct:U123",
      }),
    ).toBe(true);
  });

  it("allows only normalized members of an issued ceiling", () => {
    const client = { allowedAgentIds: ["FI-User"] };
    expect(isWebchatAgentAllowed(client, "fi-user")).toBe(true);
    expect(isWebchatAgentAllowed(client, "fi-admin")).toBe(false);
    expect(isWebchatAgentAllowed({ allowedAgentIds: [] }, "fi-user")).toBe(false);
    expect(isWebchatAgentAllowed(client, "!!!")).toBe(false);
  });

  it("derives the owner from the canonical key rather than Slack delivery state", () => {
    const session = {
      key: "agent:fi-admin:matrix:channel:!Secret:example.org:thread:$Root",
      lastChannel: "slack",
      lastAccountId: "fi-user",
    };
    expect(resolveWebchatSessionAgentId(cfg, session.key)).toBe("fi-admin");
    expect(
      isWebchatSessionAllowed({
        cfg,
        client: { allowedAgentIds: ["fi-user"] },
        sessionKey: session.key,
      }),
    ).toBe(false);
  });

  it("denies admin and superadmin sessions outside the device ceiling", () => {
    const client = { allowedAgentIds: ["fi-user"] };
    expect(isWebchatSessionAllowed({ cfg, client, sessionKey: "agent:fi-user:main" })).toBe(true);
    expect(isWebchatSessionAllowed({ cfg, client, sessionKey: "agent:fi-admin:main" })).toBe(false);
    expect(
      isWebchatSessionAllowed({
        cfg,
        client,
        sessionKey: "agent:cellect-superadmin:slack:direct:U123",
      }),
    ).toBe(false);
  });

  it("fails closed for malformed or ambiguously owned session keys", () => {
    const explicitOwnershipCfg = {
      agents: {
        ownership: "explicit",
        entries: { "fi-user": {}, "fi-admin": {} },
      },
    } as OpenClawConfig;
    const client = { allowedAgentIds: ["fi-user"] };
    expect(resolveWebchatSessionAgentId(cfg, "agent::main")).toBeNull();
    expect(isWebchatSessionAllowed({ cfg, client, sessionKey: "agent::main" })).toBe(false);
    expect(resolveWebchatSessionAgentId(explicitOwnershipCfg, "main")).toBeNull();
    expect(isWebchatSessionAllowed({ cfg: explicitOwnershipCfg, client, sessionKey: "main" })).toBe(
      false,
    );
  });
});
