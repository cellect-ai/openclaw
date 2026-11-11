import { describe, expect, it } from "vitest";
import { renderAssistantRequestFailureCopy } from "../../agents/failover/assistant-request-failure-copy.js";
import { renderControlUiAgentFailureCopy } from "../../agents/failover/user-copy.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { cellectChannelFailureCopy } from "./cellect-failure-copy.js";

const RUN = "run-7f3c";

async function delivered(channel: string, payload: ReplyPayload) {
  const { replyPayloads } = await buildReplyPayloads({
    isHeartbeat: false,
    didLogHeartbeatStrip: false,
    blockStreamingEnabled: false,
    blockReplyPipeline: null,
    replyToMode: "off",
    originatingChannel: channel as OriginatingChannelType,
    runId: RUN,
    payloads: [payload],
  });
  return replyPayloads.map((entry) => entry.text);
}

/** The three upstream renderers a Cellect member saw raw (10-20, 10-22). */
const RENDERED = {
  "assistant request failure": renderAssistantRequestFailureCopy({
    status: 500,
    provider: "openai",
  })!,
  "control ui agent failure": renderControlUiAgentFailureCopy(),
  "incomplete turn": "⚠️ Agent couldn't generate a response. Please try again.",
};
const RETRY = `I couldn't finish this; please try again (reference: run ${RUN}).`;
const CHECK_FIRST = `I couldn't finish this, and some steps may already have run, so please check before asking again (reference: run ${RUN}).`;
/** Upstream's "check the conversation before trying again" means the run may have acted. */
const EXPECTED: Record<keyof typeof RENDERED, string> = {
  "assistant request failure": RETRY,
  "control ui agent failure": CHECK_FIRST,
  "incomplete turn": RETRY,
};

describe("Cellect Slack and Matrix failure copy", () => {
  it.each(Object.entries(RENDERED))(
    "replaces %s with one plain sentence and the run id",
    async (name, text) => {
      for (const channel of ["slack", "matrix"]) {
        const [reply] = await delivered(channel, { text, isError: true });
        expect(reply).toBe(EXPECTED[name as keyof typeof RENDERED]);
        expect(reply).not.toMatch(/Control UI|openclaw|AI service|openai|model|\d{3}/i);
      }
    },
  );

  it("keeps the side-effect warning of a failed run that may have acted", async () => {
    const [reply] = await delivered("slack", {
      text: "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
      isError: true,
    });
    expect(reply).toBe(CHECK_FIRST);
  });

  it("leaves other channels, access refusals and tool warnings alone", async () => {
    const operator = RENDERED["control ui agent failure"];
    expect(await delivered("telegram", { text: operator, isError: true })).toEqual([operator]);
    const refusal = "You don’t currently have access to this agent in this conversation.";
    expect(await delivered("slack", { text: refusal, isError: true })).toEqual([refusal]);
    const warning = setReplyPayloadMetadata(
      { text: "⚠️ Exec failed: the AI service", isError: true },
      { toolErrorWarning: { toolName: "exec" } as never },
    );
    expect(cellectChannelFailureCopy(warning, { channel: "slack", runId: RUN }).text).toBe(
      "⚠️ Exec failed: the AI service",
    );
    expect(
      cellectChannelFailureCopy({ text: operator }, { channel: "slack", runId: RUN }).text,
    ).toBe(operator);
  });

  it("omits the reference when the run id is unknown", () => {
    expect(
      cellectChannelFailureCopy(
        { text: RENDERED["incomplete turn"], isError: true },
        { channel: "matrix" },
      ).text,
    ).toBe("I couldn't finish this; please try again.");
  });
});
