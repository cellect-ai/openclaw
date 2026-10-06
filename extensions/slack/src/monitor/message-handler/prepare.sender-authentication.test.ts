import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

const store = createSlackSessionStoreFixture("slack-sender-authentication-");
beforeAll(() => store.setup());
afterAll(() => store.cleanup());

describe("Slack sender authentication on the prepared turn", () => {
  it.each(["verified", "asserted", undefined] as const)(
    "reports %s to the turn context exactly as ingress resolved it",
    async (senderAuthentication) => {
      const { storePath } = store.makeTmpStorePath();
      const ctx = createInboundSlackTestContext({
        cfg: { session: { store: storePath }, channels: { slack: { enabled: true } } },
      });
      ctx.resolveUserName = async () => ({ name: "Synthetic sender" });
      const message: SlackMessageEvent = {
        type: "message",
        channel: "D123",
        channel_type: "im",
        user: "U1",
        ts: "1.000",
        text: "approve ABC234",
      };
      const prepared = await prepareSlackMessage({
        ctx,
        account: createSlackTestAccount(),
        message,
        opts: { source: "message", senderAuthentication },
      });
      expect(prepared?.ctxPayload.SenderId).toBe("U1");
      expect(prepared?.ctxPayload.SenderAuthentication).toBe(senderAuthentication);
    },
  );
});
