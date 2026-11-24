import type { WebClient } from "@slack/web-api";
import { expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackThreadStarter } from "../thread.js";

type Subtype = "message_changed" | "message_deleted";
export function registerSlackEditContextTests({
  createHandlers,
  makeEvent,
  messageQueueMock,
}: {
  createHandlers: () => {
    ctx: SlackMonitorContext;
    handler: (args: {
      event: Record<string, unknown>;
      body: unknown;
      context?: Record<string, unknown>;
      client?: object;
    }) => Promise<void>;
    handleSlackMessage: unknown;
  };
  makeEvent: (subtype: Subtype) => Record<string, unknown>;
  messageQueueMock: ReturnType<typeof vi.fn>;
}) {
  it.each(["message_changed", "message_deleted"] as const)(
    "retains exact %s context for the next turn without dispatching a new request",
    async (subtype) => {
      const { handler, handleSlackMessage } = createHandlers();
      const event =
        subtype === "message_changed"
          ? {
              ...makeEvent("message_changed"),
              message: { ts: "123.456", user: "U123", text: "Use the revised July amount" },
              previous_message: { ts: "123.456", user: "U123", text: "Obsolete June amount" },
            }
          : {
              ...makeEvent("message_deleted"),
              previous_message: { ts: "123.456", user: "U123", text: "Deleted private text" },
            };
      await handler({
        event,
        body: { api_app_id: "A_TEST", event_id: "Ev-exact-edit-context" },
        context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
        client: {},
      });
      expect(handleSlackMessage).not.toHaveBeenCalled();
      expect(messageQueueMock).toHaveBeenCalledOnce();
      const notice = messageQueueMock.mock.calls[0]?.[0];
      expect(notice).toContain("123.456");
      expect(notice).toContain("U123");
      expect(notice).toContain("C123");
      expect(notice).not.toContain("Obsolete June amount");
      expect(notice).not.toContain("Deleted private text");
      if (subtype === "message_changed") {
        expect(notice).toContain("Use the revised July amount");
      }
      expect(messageQueueMock.mock.calls[0]?.[1]).toMatchObject({ sessionKey: "agent:main:main" });
    },
  );

  it.each(["message_changed", "message_deleted"] as const)(
    "invalidates only the authorized workspace's exact cached root on %s",
    async (subtype) => {
      const { ctx, handler, handleSlackMessage } = createHandlers();
      ctx.accountId = `cache-event-${subtype}`;
      const replies = vi
        .fn()
        .mockResolvedValue({ messages: [{ ts: "123.456", user: "U123", text: "old root" }] });
      const params = {
        channelId: "C123",
        threadTs: "123.456",
        client: { conversations: { replies } } as unknown as WebClient,
        workspaceScope: { accountId: ctx.accountId, teamId: "T111" },
      };
      const other = { ...params, workspaceScope: { ...params.workspaceScope, teamId: "T222" } };
      await resolveSlackThreadStarter(params);
      await resolveSlackThreadStarter(other);
      const event = makeEvent(subtype);
      const args = {
        event,
        body: { api_app_id: "A_TEST", event_id: "Ev-cache" },
        context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
        client: {},
      };
      // Wrong installation must not invalidate another workspace's cached data.
      await handler({ ...args, context: { ...args.context, enterpriseId: "E_WRONG" } });
      expect(await resolveSlackThreadStarter(params)).toMatchObject({ text: "old root" });
      expect(replies).toHaveBeenCalledTimes(2);
      expect(messageQueueMock).not.toHaveBeenCalled();
      await handler(args);
      replies.mockResolvedValue(
        subtype === "message_changed"
          ? { messages: [{ ts: "123.456", text: "current root" }] }
          : { messages: [] },
      );
      expect(await resolveSlackThreadStarter(params)).toEqual(
        subtype === "message_changed" ? expect.objectContaining({ text: "current root" }) : null,
      );
      expect(await resolveSlackThreadStarter(other)).toMatchObject({ text: "old root" });
      expect(replies).toHaveBeenCalledTimes(3);
      expect(handleSlackMessage).not.toHaveBeenCalled();
      expect(messageQueueMock).toHaveBeenCalledOnce();
    },
  );
}
