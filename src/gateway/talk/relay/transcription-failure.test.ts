import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createTalkRealtimeRelaySession } from "./index.js";
import { makeRelayTransport } from "./index.test-support.js";
import { closeRelaySession } from "./operations.js";
import { relaySessions } from "./state.js";

const cfg = { agents: { entries: { main: {} } } };

describe("Talk relay input transcription failures", () => {
  let state: OpenClawTestState;
  const opened: string[] = [];

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "relay-transcription-failure", applyEnv: true });
  });

  afterEach(async () => {
    for (const relaySessionId of opened.splice(0)) {
      const session = relaySessions.get(relaySessionId);
      if (session) {
        await closeRelaySession(session, "completed");
      }
    }
    await state.cleanup();
  });

  it("logs the provider reason at info without failing the voice session", async () => {
    let request: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (req) => {
        request = req;
        return makeRelayTransport();
      },
    };
    const logGateway = { info: vi.fn(), warn: vi.fn() };
    const broadcastToConnIds = vi.fn();
    const session = createTalkRealtimeRelaySession({
      context: { broadcastToConnIds, chatAbortControllers: new Map(), logGateway } as never,
      connId: "conn-1",
      cfg,
      provider,
      providerConfig: {},
      controlSource: "transcript",
      instructions: "be brief",
      tools: [],
      sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
    });
    opened.push(session.relaySessionId);
    await Promise.resolve();

    request?.onEvent?.({
      direction: "server",
      type: "conversation.item.input_audio_transcription.failed",
      itemId: "item-7",
      detail: "audio too short",
    });

    expect(logGateway.info).toHaveBeenCalledWith(
      "talk relay input transcription failed: provider=relay-test item=item-7 reason=audio too short",
    );
    const errors = broadcastToConnIds.mock.calls.filter(
      ([, payload]) => (payload as { type?: string }).type === "error",
    );
    expect(errors).toEqual([]);
    expect(relaySessions.has(session.relaySessionId)).toBe(true);
  });
});
