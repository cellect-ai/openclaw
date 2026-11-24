import { expect, it } from "vitest";
import { memoryOwnerFixture } from "./session-actor-memory-family.test-support.js";
import { mutateMemory, readMemory } from "./session-actor-memory-publication.test-support.js";

const sessionKey = "agent:main:dashboard:incognito-final-debt";
const open = memoryOwnerFixture({ agentId: "main", path: "/synthetic/final-debt" });
it.each(["delete", "reset", "reclaim"] as const)(
  "native memory %s cannot discard a retained final receipt",
  async (operation) => {
    const { store } = await open(sessionKey);
    await mutateMemory(store, "session.entry.create", {
      entry: {
        sessionId: "original",
        updatedAt: 1,
        completedFinalDeliveries: [
          {
            sessionId: "original",
            intentId: "intent",
            sourceRunId: "run",
            sourceGeneration: "generation",
            completedAt: 1,
            closure: "completed",
            projectionConsumers: ["matrix"],
            deliveries: [
              {
                id: "first",
                state: "delivered",
                receipt: {
                  platformMessageId: "first",
                  finalPlatformMessageId: "last",
                  resultCount: 2,
                },
              },
            ],
          },
        ],
      },
      cwd: "/synthetic",
    });
    const expected = await readMemory(store, "session.entry.read", {});
    const outcome =
      operation === "delete"
        ? await mutateMemory(store, "session.lifecycle.delete", { expectedSessionId: "original" })
        : operation === "reset"
          ? await mutateMemory(store, "session.lifecycle.reset", {
              expected,
              nextEntry: { sessionId: "replacement", updatedAt: 2 },
            })
          : await mutateMemory(store, "session.lifecycle.reclaim", {
              entries: [{ sessionKey, expected: expected! }],
            });
    expect(outcome.kind).toBe("rolled-back");
    expect(await readMemory(store, "session.entry.read", {})).toEqual(expected);
  },
);
