import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { sessionReadHandlers } from "./sessions-read.js";
import type { GatewayRequestContext } from "./types.js";

const WEBCHAT = {
  id: "openclaw-control-ui",
  version: "test",
  platform: "web",
  mode: "webchat",
} as const;

describe("Matrix browser read authorization", () => {
  it("hides a canonical Matrix transcript from raw browser selectors", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:matrix:channel:!secret:example.org:thread:$root";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "matrix-secret",
          updatedAt: 1,
          delivery: {
            kind: "external",
            route: { channel: "slack", target: { to: "user:U123" } },
            context: { channel: "slack", to: "user:U123" },
            origin: { provider: "slack", to: "user:U123" },
          },
        },
      );
      // 2026.9.6 previews read from the gateway session-row projection.
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      do {
        await projection.ensureMaterialized();
      } while (projection.needsMaterialization);
      const context = bindSessionRowProjection(
        { getRuntimeConfig: () => ({}) },
        () => projection,
      ) as unknown as GatewayRequestContext;
      const client = { connect: { client: WEBCHAT } } as never;

      const metadataRespond = vi.fn();
      await expectDefined(
        chatHistoryHandlers["chat.metadata"],
        "metadata handler",
      )({
        params: { agentId: "main", sessionKey },
        context,
        client,
        respond: metadataRespond,
        req: {} as never,
        isWebchatConnect: () => true,
      });
      expect(metadataRespond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );

      const previewRespond = vi.fn();
      await expectDefined(
        sessionReadHandlers["sessions.preview"],
        "preview handler",
      )({
        params: { keys: [sessionKey] },
        context,
        client,
        respond: previewRespond,
        req: {} as never,
        isWebchatConnect: () => true,
      });
      expect(previewRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ previews: [{ key: sessionKey, status: "missing", items: [] }] }),
        undefined,
      );
    });
  });
});
