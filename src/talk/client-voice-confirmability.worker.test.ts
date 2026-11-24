import { assert, describe, expect, it, vi } from "vitest";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { seedSession } from "./client-voice-session.fixture.test-support.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  isClientVoiceSessionConfirmable,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";

const { useClientVoiceSessionHarness } = await vi.hoisted(
  () => import("./client-voice-session.harness.test-support.js"),
);

describe("voice confirmation capability from the native run owner", () => {
  const { releaseHeldWrites } = useClientVoiceSessionHarness();
  const target = { agentId: "main", sessionKey: "agent:main:main" };

  async function open(origin: "client" | "relay", transcriptCapable = false) {
    const voiceSessionId = await createOrResumeClientVoiceSession({
      ...target,
      origin,
      transcriptCapable,
    });
    const runId = `confirm-${voiceSessionId}`;
    const release = await registerClientVoiceConsultRun({ ...target, voiceSessionId, runId });
    const binding = resolveClientVoiceRunBinding(runId);
    assert(binding);
    return { binding, runId, release };
  }

  it.each([
    ["client", false, false],
    ["client", true, true],
    ["relay", false, true],
  ] as const)(
    "reads %s transcript capability %s through the native worker",
    async (origin, capable, expected) => {
      const run = await open(origin, capable);
      try {
        expect(await isClientVoiceSessionConfirmable(run.binding, run.runId)).toBe(expected);
      } finally {
        run.release();
      }
    },
  );

  it("observes a later committed user transcript without replacing the run binding", async () => {
    // A user transcript is appended to an existing agent session, never one it creates.
    await seedSession(target.sessionKey);
    const run = await open("client");
    try {
      expect(await isClientVoiceSessionConfirmable(run.binding, run.runId)).toBe(false);
      await appendClientVoiceTranscript({
        ...run.binding,
        sessionTarget: { sessionKey: target.sessionKey },
        entryId: "capability-transcript",
        role: "user",
        text: "Please continue",
      });
      expect(await isClientVoiceSessionConfirmable(run.binding, run.runId)).toBe(true);
    } finally {
      run.release();
    }
  });

  it("retains confirmation for an admitted consult after its transport closes", async () => {
    const run = await open("client", true);
    try {
      await closeClientVoiceSession({ ...run.binding, config: {} });
      expect(await isClientVoiceSessionConfirmable(run.binding, run.runId)).toBe(true);
    } finally {
      run.release();
    }
  });

  it("rejects a copied or retired run binding instead of granting a legacy bypass", async () => {
    const run = await open("client");
    try {
      await expect(isClientVoiceSessionConfirmable({ ...run.binding }, run.runId)).rejects.toThrow(
        "binding is unavailable",
      );
      run.release();
      await expect(isClientVoiceSessionConfirmable(run.binding, run.runId)).rejects.toThrow(
        "binding is unavailable",
      );
    } finally {
      run.release();
    }
  });

  it("rejects retirement while the native capability read waits for its worker", async () => {
    const run = await open("client");
    const gate = createEnteredGate();
    releaseHeldWrites.push(gate.release);
    const blocked = runOpenClawAgentWorkerWrite(target, gate.wait);
    await gate.entered;
    try {
      const pending = isClientVoiceSessionConfirmable(run.binding, run.runId);
      const rejected = expect(pending).rejects.toThrow("binding changed");
      run.release();
      gate.release();
      await blocked;
      await rejected;
    } finally {
      gate.release();
      run.release();
    }
  });
});
