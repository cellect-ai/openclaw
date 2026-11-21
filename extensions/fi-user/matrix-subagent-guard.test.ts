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
      expect(matrixSubagentSpawnBlock("sessions_spawn", key)).toEqual({
        block: true,
        blockReason: MATRIX_SUBAGENT_REFUSAL,
      });
    }
    expect(MATRIX_SUBAGENT_REFUSAL).toContain("fi_user_desk_handoff");
  });
  it("leaves Slack-origin spawns, other tools and unknown sessions alone", () => {
    expect(
      matrixSubagentSpawnBlock(
        "sessions_spawn",
        "agent:cellect-fi-admin:slack:channel:c1:thread:1.2",
      ),
    ).toBeUndefined();
    expect(
      matrixSubagentSpawnBlock("subagents", "agent:cellect-fi-user:matrix:channel:!r:m"),
    ).toBeUndefined();
    expect(matrixSubagentSpawnBlock("sessions_spawn", undefined)).toBeUndefined();
  });
  it("recognizes sub-agent sessions", () => {
    expect(
      isSubagentSession("agent:cellect-fi-user:subagent:7ecedfe5-40fe-4ab9-8af8-d96600e53cad"),
    ).toBe(true);
    expect(isSubagentSession("agent:cellect-fi-user:matrix:channel:!r:m")).toBe(false);
    expect(isSubagentSession(undefined)).toBe(false);
  });
});
