import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { announceTalkRealtimeRelayAnswer, createTalkRealtimeRelaySession } from "./index.js";
import { createIdleRelayProvider, makeRelayTransport } from "./index.test-support.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";

const activeRelaySessions = new Map<string, string>();

function startRelay(bridge = makeRelayTransport({ sendUserMessage: vi.fn() })) {
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  const session = createTalkRealtimeRelaySession({
    context: { broadcastToConnIds: vi.fn(), chatAbortControllers: new Map() } as never,
    connId: "conn-1",
    provider: createIdleRelayProvider(() => bridge),
    providerConfig: {},
    instructions: "be brief",
    tools: [],
    controlSource: "transcript",
    cfg,
    sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
  });
  activeRelaySessions.set(session.relaySessionId, "conn-1");
  return { bridge, relaySessionId: session.relaySessionId };
}

describe("talk realtime relay answer announcement", () => {
  usePersistentRelayTestState(activeRelaySessions);

  it("has the owner's voice say it has an answer and summarise it", async () => {
    const { bridge, relaySessionId } = startRelay();
    await Promise.resolve();

    await announceTalkRealtimeRelayAnswer({
      relaySessionId,
      connId: "conn-1",
      text: "The draw was funded on Tuesday.",
    });

    expect(bridge.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
      "An answer to the user's earlier request is ready. Say exactly 'I have an answer,' then summarise the following for speech in under 45 seconds. Do not read links, ids or tables. Then stop and listen.\n\nThe draw was funded on Tuesday.",
    );
  });

  it("refuses another connection and an unknown session without speaking", async () => {
    const { bridge, relaySessionId } = startRelay();
    await Promise.resolve();

    expect(() =>
      announceTalkRealtimeRelayAnswer({ relaySessionId, connId: "conn-2", text: "answer" }),
    ).toThrow("Unknown realtime relay session");
    expect(() =>
      announceTalkRealtimeRelayAnswer({
        relaySessionId: "missing",
        connId: "conn-1",
        text: "answer",
      }),
    ).toThrow("Unknown realtime relay session");
    expect(bridge.sendUserMessage).not.toHaveBeenCalled();
  });

  it("reports a provider that cannot be told what to say", async () => {
    const { relaySessionId } = startRelay(makeRelayTransport());
    await Promise.resolve();

    expect(() =>
      announceTalkRealtimeRelayAnswer({ relaySessionId, connId: "conn-1", text: "answer" }),
    ).toThrow("Realtime voice provider cannot speak an announcement");
  });
});
