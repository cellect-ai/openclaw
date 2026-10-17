import type { WebClient } from "@slack/web-api";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { invalidateSlackThreadStarter, resolveSlackThreadStarter } from "./thread.js";

function setup(name: string) {
  const replies = vi.fn();
  const client = { conversations: { replies } } as unknown as WebClient;
  const params = {
    client,
    channelId: "C_CACHE",
    threadTs: "100.001",
    workspaceScope: { accountId: `cache-${name}`, teamId: "T_CACHE" },
  };
  const root = (text: string) => ({ messages: [{ ts: params.threadTs, user: "U_AUTHOR", text }] });
  const invalidate = () => invalidateSlackThreadStarter({ ...params, messageTs: params.threadTs });
  return { replies, params, root, invalidate };
}

it.each(["edit", "delete"] as const)(
  "invalidates an authorized %s root without a thread_ts field",
  async (kind) => {
    const f = setup(kind);
    f.replies.mockResolvedValueOnce(f.root("original root"));
    expect(await resolveSlackThreadStarter(f.params)).toMatchObject({ text: "original root" });
    f.invalidate();
    f.replies.mockResolvedValueOnce(kind === "edit" ? f.root("edited root") : { messages: [] });
    expect(await resolveSlackThreadStarter(f.params)).toEqual(
      kind === "edit"
        ? {
            text: "edited root",
            ts: f.params.threadTs,
            userId: "U_AUTHOR",
            botId: undefined,
            files: undefined,
          }
        : null,
    );
    expect(f.replies).toHaveBeenCalledTimes(2);
  },
);

it.each(["account", "team", "channel", "message"] as const)(
  "isolates invalidation from a different %s",
  async (dimension) => {
    const f = setup(`scope-${dimension}`);
    f.replies.mockResolvedValueOnce(f.root("retained root"));
    await resolveSlackThreadStarter(f.params);
    invalidateSlackThreadStarter({
      channelId: dimension === "channel" ? "C_OTHER" : f.params.channelId,
      messageTs: dimension === "message" ? "100.002" : f.params.threadTs,
      workspaceScope: {
        accountId: dimension === "account" ? "other-account" : f.params.workspaceScope.accountId,
        teamId: dimension === "team" ? "T_OTHER" : f.params.workspaceScope.teamId,
      },
    });
    expect(await resolveSlackThreadStarter(f.params)).toMatchObject({ text: "retained root" });
    expect(f.replies).toHaveBeenCalledOnce();
  },
);

it("does not return or reinstall an invalidated in-flight root for any awaiting reader", async () => {
  const f = setup("in-flight");
  const response = createDeferred<ReturnType<typeof f.root>>();
  f.replies.mockReturnValueOnce(response.promise);
  const old = resolveSlackThreadStarter(f.params);
  const shared = resolveSlackThreadStarter(f.params);
  expect(f.replies).toHaveBeenCalledOnce();
  f.invalidate();
  f.replies.mockResolvedValueOnce(f.root("current root"));
  expect(await resolveSlackThreadStarter(f.params)).toMatchObject({ text: "current root" });
  response.resolve(f.root("stale root"));
  expect(await old).toBeNull();
  expect(await shared).toBeNull();
  expect(await resolveSlackThreadStarter(f.params)).toMatchObject({ text: "current root" });
  expect(f.replies).toHaveBeenCalledTimes(2);
});

it("a forced fresh room-history read fences older cached or in-flight starters", async () => {
  const f = setup("refresh");
  const response = createDeferred<ReturnType<typeof f.root>>();
  f.replies.mockReturnValueOnce(response.promise);
  const old = resolveSlackThreadStarter(f.params);
  f.replies.mockResolvedValueOnce(f.root("fresh room root"));
  expect(await resolveSlackThreadStarter({ ...f.params, refresh: true })).toMatchObject({
    text: "fresh room root",
  });
  response.resolve(f.root("old room root"));
  expect(await old).toBeNull();
  expect(await resolveSlackThreadStarter(f.params)).toMatchObject({ text: "fresh room root" });
  expect(f.replies).toHaveBeenCalledTimes(2);
});

it("never relabels a remaining reply as the deleted thread starter", async () => {
  const f = setup("missing-root");
  f.replies.mockResolvedValueOnce({ messages: [{ ts: "100.002", text: "remaining reply" }] });
  expect(await resolveSlackThreadStarter(f.params)).toBeNull();
  f.replies.mockResolvedValueOnce(f.root("restored exact root"));
  expect(await resolveSlackThreadStarter(f.params)).toMatchObject({ text: "restored exact root" });
});
