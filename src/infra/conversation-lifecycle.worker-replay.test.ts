import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { AgentEventPayload } from "./agent-events.types.js";
import { prepareConversationLifecycleWrite } from "./conversation-lifecycle-persistence.js";
import { readLifecycleRecordReceipt } from "./conversation-lifecycle-receipt.js";
import type { LifecycleRecordInput } from "./conversation-lifecycle-record.worker.js";
import { captureDeliveryQueueStateContext } from "./delivery-queue-state-context.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";

it("exact worker replay does not repeat queued, approval, card or terminal revisions", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const context = captureDeliveryQueueStateContext(stateDir);
    const now = Date.UTC(2026, 10, 23);
    const events: Array<
      Pick<AgentEventPayload, "stream" | "data"> & { state: LifecycleRecordInput["incomingState"] }
    > = [
      { stream: "admission", data: {}, state: "queued" },
      { stream: "lifecycle", data: { phase: "start", startedAt: now }, state: "running" },
      {
        stream: "approval",
        data: {
          phase: "requested",
          status: "pending",
          kind: "plugin",
          approvalId: "approval-0001",
          chatDecidable: true,
          expiresAtMs: now + 60_000,
          allowedDecisions: ["allow-once", "deny"],
          conversation: { title: "Approve draft", summary: "Send this test draft." },
        },
        state: "waiting",
      },
      {
        stream: "approval",
        data: { phase: "resolved", status: "approved", approvalId: "approval-0001" },
        state: "running",
      },
      { stream: "lifecycle", data: { phase: "end", executionSettled: true }, state: "completed" },
    ];
    let requested: LifecycleRecordInput | undefined;
    const persist = (input: LifecycleRecordInput) =>
      prepareConversationLifecycleWrite({
        context,
        stateDir,
        command: { type: "deliveryQueue.lifecycleRecord", input },
        assertCurrent: () => {},
        readReceipt: readLifecycleRecordReceipt,
      })();
    for (const [index, event] of events.entries()) {
      const input: LifecycleRecordInput = {
        event: {
          runId: "replayed-run",
          stream: event.stream,
          data: event.data,
          seq: index,
          ts: now + index,
        },
        incomingState: event.state,
        generation: "one-generation",
        sessionId: "one-session",
        transportId: "one-transport",
        bindings: [
          {
            environment: "test",
            conversationId: "conversation-0001",
            roomId: "!room:matrix.test",
            bindingId: "binding-0001",
            accountId: "bot",
            threadRootEventId: "$root",
            sessionKey: "agent:main:room",
            agentId: "main",
          },
        ],
        registeredAt: now,
        executionOwner: true,
        signals: true,
        cards: true,
        cappedRooms: [],
        interruptedSent: [],
      };
      // Fresh requests model replay only after the prior native owner settled.
      await persist(input);
      await persist(input);
      if (event.data.phase === "requested") requested = input;
      if (event.data.phase === "resolved" && requested) {
        await persist(requested);
        const [current] = await executeDeliveryQueueOperation(context, stateDir, {
          type: "deliveryQueue.lifecycleRead",
          input: {},
        });
        expect(current).toMatchObject({ revision: 4, state: "running", pendingApprovals: [] });
        await expect(
          persist({
            ...input,
            event: { ...input.event, data: { ...input.event.data, status: "denied" } },
          }),
        ).rejects.toThrow("occurrence changed during replay");
      }
    }
    const rows = await executeDeliveryQueueOperation(context, stateDir, {
      type: "deliveryQueue.lifecycleRead",
      input: {},
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      revision: 5,
      state: "completed",
      pendingApprovals: [],
      cards: { "approval-0001": { revision: 2, status: "approved" } },
    });
    expect(rows[0]?.pending.map((event) => [event.state, event.revision])).toEqual([
      ["queued", 1],
      ["running", 2],
      ["waiting", 3],
      ["running", 4],
      ["completed", 5],
    ]);
  });
});
