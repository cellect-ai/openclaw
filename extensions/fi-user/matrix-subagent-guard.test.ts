import { describe, expect, it } from "vitest";
import {
  isSubagentSession,
  MATRIX_SUBAGENT_REFUSAL,
  matrixSubagentSpawnBlock,
} from "./matrix-subagent-guard.js";

describe("Matrix sub-agent guard", () => {
  it("refuses a spawn from any Matrix conversation, naming what to do instead", () => {
    for (const key of [
      "agent:cellect-fi-user:matrix:channel:!muNYQ5vYcCmhpUZz3Z:matrix.cellect.ai:thread:$root",
      "agent:cellect-fi-admin:matrix:group:!room:matrix.example",
    ]) {
      expect(matrixSubagentSpawnBlock("sessions_spawn", { sessionKey: key })).toEqual({
        block: true,
        blockReason: MATRIX_SUBAGENT_REFUSAL,
      });
    }
    expect(MATRIX_SUBAGENT_REFUSAL).toContain("fi_user_desk_handoff");
  });
  it("decides by the run's channel: a source-linked Matrix turn on a Slack key is blocked", () => {
    const slackKey = "agent:cellect-fi-user:slack:channel:c1:thread:1.2";
    expect(
      matrixSubagentSpawnBlock("sessions_spawn", {
        sessionKey: slackKey,
        requester: { channel: "matrix" },
      }),
    ).toMatchObject({ block: true });
    expect(
      matrixSubagentSpawnBlock("sessions_spawn", {
        sessionKey: slackKey,
        requesterContinuation: { channel: "matrix" },
      }),
    ).toMatchObject({ block: true });
    expect(
      matrixSubagentSpawnBlock("sessions_spawn", {
        sessionKey: slackKey,
        requester: { channel: "slack" },
      }),
    ).toBeUndefined();
    // A non-Matrix run on a Matrix-shaped key gives its child a non-Matrix channel, which Fi does not gate per event.
    expect(
      matrixSubagentSpawnBlock("sessions_spawn", {
        sessionKey: "agent:cellect-fi-user:matrix:channel:!r:m",
        requester: { channel: "cron" },
      }),
    ).toBeUndefined();
  });
  it("leaves other tools and unknown sessions alone", () => {
    expect(
      matrixSubagentSpawnBlock("subagents", {
        sessionKey: "agent:cellect-fi-user:matrix:channel:!r:m",
      }),
    ).toBeUndefined();
    expect(matrixSubagentSpawnBlock("sessions_spawn", {})).toBeUndefined();
  });
  it("recognizes sub-agent sessions", () => {
    expect(
      isSubagentSession("agent:cellect-fi-user:subagent:7ecedfe5-40fe-4ab9-8af8-d96600e53cad"),
    ).toBe(true);
    expect(isSubagentSession("agent:cellect-fi-user:acp:5f0c")).toBe(true);
    expect(isSubagentSession("agent:cellect-fi-user:acp:binding:matrix:room-1")).toBe(false);
    expect(isSubagentSession("agent:cellect-fi-user:matrix:channel:!r:m")).toBe(false);
    expect(isSubagentSession(undefined)).toBe(false);
  });
});
