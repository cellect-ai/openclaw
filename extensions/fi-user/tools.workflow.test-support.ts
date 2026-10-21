import { createHmac } from "node:crypto";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { adminActionSessions } from "./admin-action.js";
import type { approvalStores } from "./admin-action.test-support.js";
import type { FiUserMatrixEnvironmentHarness } from "./tools.matrix-environment.test-support.js";

type WorkflowHarness = Pick<
  FiUserMatrixEnvironmentHarness,
  "BROKER" | "calls" | "context" | "json" | "routes"
> & {
  bodyJson: (init: RequestInit | undefined) => Record<string, unknown>;
  mocks: {
    sendMedia: ReturnType<typeof vi.fn>;
    sendText: ReturnType<typeof vi.fn>;
    subagentRun: ReturnType<typeof vi.fn>;
    waitForRun: ReturnType<typeof vi.fn>;
    getSessionMessages: ReturnType<typeof vi.fn>;
  };
  plugin: () => {
    stores: ReturnType<typeof approvalStores>;
    tool: (name: string, context: OpenClawPluginToolContext) => AnyAgentTool;
    hook: (name: string) => (event: never, context: never) => unknown;
  };
};

// Reuse the parent suite's module mocks and registered-plugin fixture.
export function registerFiUserWorkflowTests(harness: WorkflowHarness) {
  const { BROKER, bodyJson, calls, context, json, mocks, plugin, routes } = harness;
  describe("fi_user_deliver_file", () => {
    it("returns the login-gated Fi link in a channel", async () => {
      routes.push((url, init) =>
        url.pathname === "/api/shape/documents/share" && init.method === "POST"
          ? json({
              kind: "authenticated",
              url: "https://fi.example.test/api/shape/305-third/docs/doc-1/file?preview=1",
              access: "sign-in",
            })
          : undefined,
      );
      const result = await plugin()
        .tool("fi_user_deliver_file", context())
        .execute("f1", { documentId: "doc-1", project: "305-third" });
      expect(result.details).toMatchObject({
        delivered: "link",
        url: expect.stringContaining("/docs/doc-1/file"),
      });
      const share = calls.find((entry) => entry.url.endsWith("/documents/share"));
      expect(bodyJson(share!.init)).toEqual({
        documentId: "doc-1",
        project: "305-third",
      });
    });

    it("attaches the file in the requester's own Slack DM", async () => {
      routes.push((url) =>
        url.pathname === "/api/shape/305-third/docs/doc-1/file"
          ? new Response("%PDF-1.4", {
              headers: { "content-disposition": 'attachment; filename="CO-001.pdf"' },
            })
          : undefined,
      );
      mocks.sendMedia.mockResolvedValue({ messageId: "m1" });
      const result = await plugin()
        .tool(
          "fi_user_deliver_file",
          context({
            sessionKey: "agent:cellect-fi-user:slack:direct:U12345678",
            nativeChannelId: "D0DM000001",
          }),
        )
        .execute("f2", { documentId: "doc-1", project: "305-third" });
      expect(result.details).toMatchObject({ delivered: "slack_dm", file: "CO-001.pdf" });
      expect(mocks.sendMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user:U12345678",
          accountId: "fi-user",
          forceDocument: true,
        }),
      );
    });
  });

  describe("fi_user_esign", () => {
    const list = {
      templates: [
        {
          sourceDocumentId: "doc-1",
          templateId: 5,
          ownerEmail: "owner@example.com",
          additionalSignerRoles: [],
          sent: false,
        },
        {
          sourceDocumentId: "doc-2",
          templateId: 6,
          ownerEmail: "owner@example.com",
          additionalSignerRoles: ["Contractor"],
          sent: false,
        },
      ],
    };

    it("previews a send with stored defaults and sends only after confirmation", async () => {
      routes.push((url, init) => {
        if (url.pathname === "/api/shape/559-first/esign" && (init.method ?? "GET") === "GET") {
          return json(list);
        }
        if (url.pathname === "/api/shape/559-first/esign/send") {
          return json({ ok: true, submissionId: 140 });
        }
        return undefined;
      });
      const tool = plugin().tool("fi_user_esign", context());
      const preview = await tool.execute("e1", {
        action: "send",
        project: "559-first",
        documentId: "doc-1",
        templateId: 5,
      });
      expect(preview.details).toMatchObject({
        preview: true,
        signer: "owner@example.com",
        completionCopies: ["member@example.com"],
      });
      expect(calls.some((entry) => entry.url.endsWith("/esign/send"))).toBe(false);
      await tool.execute("e2", {
        action: "send",
        project: "559-first",
        documentId: "doc-1",
        templateId: 5,
        confirmSend: true,
      });
      const send = calls.find((entry) => entry.url.endsWith("/esign/send"));
      expect(bodyJson(send!.init)).toEqual({
        documentId: "doc-1",
        templateId: 5,
        recipientsConfirmed: true,
        additionalSignerRecipients: [],
        completionBcc: ["member@example.com"],
      });
    });

    it("sends a template needing extra signers to an administrator instead", async () => {
      routes.push((url) =>
        url.pathname === "/api/shape/559-first/esign" ? json(list) : undefined,
      );
      await expect(
        plugin().tool("fi_user_esign", context()).execute("e3", {
          action: "send",
          project: "559-first",
          documentId: "doc-2",
          templateId: 6,
          confirmSend: true,
        }),
      ).rejects.toThrow(/request_admin_action/);
    });

    it("resends to an existing signer through Fi as the requester", async () => {
      routes.push((url, init) =>
        url.pathname === "/api/shape/559-first/esign/submissions/124/resend" &&
        init.method === "POST"
          ? json({ ok: true, resentTo: ["signer@example.com"] })
          : undefined,
      );
      const result = await plugin()
        .tool("fi_user_esign", context())
        .execute("e4", { action: "resend", project: "559-first", submissionId: 124 });
      expect(result.details).toMatchObject({ resentTo: ["signer@example.com"] });
    });
  });

  describe("fi_user_budget_import", () => {
    const rows = [{ costCode: "20-100", description: "Hardwood floors", amount: 40_000 }];

    it("applies only the exact source the requester saw in a dry run, after confirmation", async () => {
      routes.push((url) =>
        url.pathname === "/api/shape/305-third/budget/revisions/import"
          ? json({ ok: true })
          : undefined,
      );
      const tool = plugin().tool("fi_user_budget_import", context());
      const base = { project: "305-third", label: "Rev 4", changeNote: "Floors allowance" };
      await expect(
        tool.execute("b1", { ...base, rows, mode: "apply", confirmApply: true }),
      ).rejects.toThrow(/dry-run/);
      await tool.execute("b2", { ...base, rows });
      await expect(tool.execute("b3", { ...base, rows, mode: "apply" })).rejects.toThrow(
        /confirmApply/,
      );
      await expect(
        tool.execute("b4", {
          ...base,
          rows: [{ ...rows[0], amount: 45_000 }],
          mode: "apply",
          confirmApply: true,
        }),
      ).rejects.toThrow(/dry-run/);
      await tool.execute("b5", { ...base, rows, mode: "apply", confirmApply: true });
      const modes = calls
        .filter((entry) => entry.url.endsWith("/budget/revisions/import"))
        .map((entry) => bodyJson(entry.init).mode);
      expect(modes).toEqual(["dry-run", "apply"]);
    });
  });

  describe("request_admin_action", () => {
    it("never redirects an explicit unknown code or lets another Slack thread decide", async () => {
      const instance = plugin();
      const ctx = context({
        delivery: { send: vi.fn() },
        deliveryContext: {
          channel: "slack",
          to: "C0CHANNEL1",
          accountId: "fi-user",
          threadId: "1710000000.000100",
        },
      });
      const result = await instance.tool("request_admin_action", ctx).execute("request", {
        task: "external_share_link",
        project: "project",
        documentId: "doc",
        recipientEmail: "recipient@example.test",
      });
      const requestId = (result.details as { requestId: string }).requestId;
      const hook = instance.hook("before_dispatch");
      await expect(
        hook(
          {
            content: "approve ZZZ999",
            senderId: "UALEX00001",
            senderAuthentication: "verified",
            sessionKey: ctx.sessionKey,
          } as never,
          { channelId: "slack", sessionKey: ctx.sessionKey } as never,
        ),
      ).resolves.toMatchObject({
        handled: true,
        text: expect.stringContaining("not found or has expired"),
      });
      await expect(
        hook(
          {
            content: `approve ${requestId}`,
            senderId: "UALEX00001",
            senderAuthentication: "verified",
            sessionKey: "another-thread",
          } as never,
          { channelId: "slack", sessionKey: "another-thread" } as never,
        ),
      ).resolves.toEqual({ handled: true });
      const row = instance.stores.namespaces.get("admin-actions")!.get(requestId) as Record<
        string,
        unknown
      >;
      expect(row.status).toBe("pending");
      row.origin = {
        orgId: "org-shape",
        roomId: "!room:example.test",
        threadRootEventId: "$root",
        agentMxid: "@bot:example.test",
      };
      await expect(
        hook(
          {
            content: `approve ${requestId}`,
            senderId: "UALEX00001",
            senderAuthentication: "verified",
            sessionKey: ctx.sessionKey,
          } as never,
          { channelId: "slack", sessionKey: ctx.sessionKey } as never,
        ),
      ).resolves.toEqual({ handled: true });
      expect(row.status).toBe("pending");
      expect(mocks.subagentRun).not.toHaveBeenCalled();
    });
    it("posts an approval card and records approval without an unrestricted admin run", async () => {
      const send = vi.fn();
      const instance = plugin();
      const ctx = context({
        delivery: { send },
        deliveryContext: {
          channel: "slack",
          to: "C0CHANNEL1",
          accountId: "fi-user",
          threadId: "1710000000.000100",
        },
      });
      const result = await instance.tool("request_admin_action", ctx).execute("a1", {
        task: "esign_change_recipient",
        project: "559-first",
        submissionId: 124,
        currentSignerEmail: "old@example.com",
        newSignerEmail: "asorc@example.com",
        reason: "Signer asked for a different address",
      });
      const requestId = (result.details as { requestId: string }).requestId;
      expect(requestId).toMatch(/^[A-Z0-9]{6}$/);
      const card = send.mock.calls[0]![0].text as string;
      expect(card).toContain("<@UALEX00001> <@ULORENZO01>");
      expect(card).toContain(`approve ${requestId}`);
      expect(card).toContain("<@U12345678>");

      mocks.subagentRun.mockResolvedValue({ runId: "run-1" });
      mocks.waitForRun.mockResolvedValue({ status: "ok" });
      mocks.getSessionMessages.mockResolvedValue({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Signer changed; DocuSeal resent to asorc@example.com." },
            ],
          },
        ],
      });
      const dispatch = instance.hook("before_dispatch");
      const received = (event: never, hookContext: never) =>
        dispatch(event, { sessionKey: ctx.sessionKey, ...(hookContext as object) } as never);
      // Not an approver: ignored, and left to the conversation as an ordinary turn.
      await expect(
        received(
          {
            content: `approve ${requestId}`,
            senderId: "U12345678",
            senderAuthentication: "verified",
          } as never,
          { channelId: "slack" } as never,
        ),
      ).resolves.toBeUndefined();
      expect(mocks.subagentRun).not.toHaveBeenCalled();
      // An approver's unrelated remark is theirs to make: no request, no claim.
      await expect(
        received(
          {
            content: "approved the budget yesterday",
            senderId: "UALEX00001",
            senderAuthentication: "verified",
          } as never,
          { channelId: "slack" } as never,
        ),
      ).resolves.toBeUndefined();
      expect(mocks.subagentRun).not.toHaveBeenCalled();

      // A sender id Slack did not itself prove decides nothing, and is not a turn.
      await expect(
        received(
          { content: `approve ${requestId}`, senderId: "UALEX00001" } as never,
          { channelId: "slack" } as never,
        ),
      ).resolves.toEqual({ handled: true });
      expect(mocks.subagentRun).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(mocks.sendText).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining("did not verify") }),
        ),
      );
      mocks.sendText.mockClear();

      // The approval is claimed, so the same text never becomes an agent turn.
      await expect(
        received(
          {
            content: `approve ${requestId}`,
            senderId: "UALEX00001",
            senderAuthentication: "verified",
          } as never,
          { channelId: "slack" } as never,
        ),
      ).resolves.toEqual({ handled: true });
      await vi.waitFor(() => expect(mocks.sendText).toHaveBeenCalled());
      expect(mocks.subagentRun).not.toHaveBeenCalled();
      expect(mocks.sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "C0CHANNEL1",
          threadId: "1710000000.000100",
          text: expect.stringContaining("Not executed"),
        }),
      );

      // A second approval does not start another run; it is noted in the thread
      // and still claimed, so it cannot reach an agent either.
      await expect(
        received(
          {
            content: `approve ${requestId}`,
            senderId: "ULORENZO01",
            senderAuthentication: "verified",
          } as never,
          { channelId: "slack" } as never,
        ),
      ).resolves.toEqual({ handled: true });
      await vi.waitFor(() =>
        expect(mocks.sendText).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining("already decided") }),
        ),
      );
      expect(mocks.subagentRun).not.toHaveBeenCalled();
    });

    it("records a denial from an approver who mentions the bot first, and runs nothing", async () => {
      const instance = plugin();
      const ctx = context({
        delivery: { send: vi.fn() },
        deliveryContext: {
          channel: "slack",
          to: "C0CHANNEL1",
          accountId: "fi-user",
          threadId: "1710000000.000100",
        },
      });
      const result = await instance.tool("request_admin_action", ctx).execute("a4", {
        task: "external_share_link",
        project: "90-bright",
        documentId: "doc-geo",
        recipientEmail: "federico@example.com",
      });
      const requestId = (result.details as { requestId: string }).requestId;
      await expect(
        instance.hook("before_dispatch")(
          {
            content: `<@UFIUSERBOT> deny ${requestId}`,
            senderId: "UALEX00001",
            senderAuthentication: "verified",
            sessionKey: ctx.sessionKey,
          } as never,
          { channelId: "slack" } as never,
        ),
      ).resolves.toEqual({ handled: true });
      await vi.waitFor(() => expect(mocks.sendText).toHaveBeenCalled());
      expect(mocks.sendText.mock.calls[0]![0].text).toContain("declined");
      expect(mocks.subagentRun).not.toHaveBeenCalled();
    });

    it("files an access request as the requester in Fi", async () => {
      routes.push((url, init) =>
        url.pathname === "/api/shape/access-requests" && init.method === "POST"
          ? json({
              ok: true,
              request: { id: 3 },
              approvalUrl: "https://fi.example.test/shape/settings?tab=access&request=3",
            })
          : undefined,
      );
      const send = vi.fn();
      const result = await plugin()
        .tool("request_admin_action", context({ delivery: { send } }))
        .execute("a2", {
          task: "access_request",
          targetType: "project",
          targetId: "82-sussex",
          reason: "Title work",
        });
      const call = calls.find((entry) => entry.url.endsWith("/access-requests"));
      expect(bodyJson(call!.init)).toMatchObject({
        requesterEmail: "member@example.com",
        target: { type: "project", id: "82-sussex" },
      });
      expect(result.details).toMatchObject({ filed: true, cardPosted: true });
      expect(send.mock.calls[0]![0].text).toContain("approve or deny in Fi");
      expect(mocks.subagentRun).not.toHaveBeenCalled();
    });

    it("requires the fields of the chosen task", async () => {
      await expect(
        plugin()
          .tool("request_admin_action", context())
          .execute("a3", { task: "external_share_link", project: "x" }),
      ).rejects.toThrow(/documentId, recipientEmail/);
    });
  });

  describe("before_tool_call", () => {
    function verify(assertion: string) {
      const [header, payload, signature] = assertion.split(".");
      expect(createHmac("sha256", BROKER).update(`${header}.${payload}`).digest("base64url")).toBe(
        signature,
      );
      return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    }

    it("injects a gateway-signed on-behalf-of assertion into fi-admin exec", () => {
      const hook = plugin().hook("before_tool_call");
      const result = hook(
        {
          toolName: "exec",
          params: {
            command: "npm run rooms:filing -- inspect",
            env: { FI_ON_BEHALF_OF: "forged", KEEP: "1" },
          },
        } as never,
        {
          agentId: "cellect-fi-admin",
          toolName: "exec",
          requester: { channel: "slack", senderId: "u12345678" },
        } as never,
      ) as { params: { env: Record<string, string> } };
      expect(result.params.env.KEEP).toBe("1");
      const claims = verify(result.params.env.FI_ON_BEHALF_OF!);
      expect(claims).toMatchObject({
        iss: "openclaw-gateway",
        aud: "fi-on-behalf-of",
        agent_id: "cellect-fi-admin",
        requester_slack_user_id: "U12345678",
      });
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(15 * 60);
      expect(JSON.stringify(result)).not.toContain(BROKER);
    });

    it("drops a model-supplied assertion when there is no verified requester", () => {
      const hook = plugin().hook("before_tool_call");
      const result = hook(
        {
          toolName: "exec",
          params: { command: "true", env: { FI_ON_BEHALF_OF: "replayed" } },
        } as never,
        {
          agentId: "cellect-main",
          toolName: "exec",
          requester: { channel: "webchat", senderId: "webchat-ui" },
        } as never,
      ) as { params: Record<string, unknown> };
      // The host merges hook params over the model's: an omitted env would restore the replay.
      expect(result.params).toEqual({ command: "true", env: {} });
    });

    it("leaves other agents and tools alone", () => {
      const hook = plugin().hook("before_tool_call");
      expect(
        hook(
          { toolName: "exec", params: { command: "x" } } as never,
          { agentId: "cellect-fi-user", toolName: "exec" } as never,
        ),
      ).toBeUndefined();
      expect(
        hook(
          { toolName: "read", params: {} } as never,
          { agentId: "cellect-fi-admin", toolName: "read" } as never,
        ),
      ).toBeUndefined();
    });

    it("keeps fi-admin from handing work off", () => {
      const hook = plugin().hook("before_tool_call");
      expect(
        hook(
          { toolName: "sessions_send", params: {} } as never,
          { agentId: "cellect-fi-admin" } as never,
        ),
      ).toMatchObject({ block: true });
      expect(
        hook(
          { toolName: "sessions_spawn", params: { agentId: "cellect-main" } } as never,
          { agentId: "cellect-fi-admin" } as never,
        ),
      ).toMatchObject({ block: true });
      expect(
        hook(
          { toolName: "message", params: {} } as never,
          {
            agentId: "cellect-fi-admin",
            sessionKey: "agent:cellect-fi-admin:admin-action:abc234",
          } as never,
        ),
      ).toMatchObject({ block: true });
    });

    it("blocks unrestricted exec even after administrator approval", () => {
      const sessionKey = "agent:cellect-fi-admin:admin-action:zzz222";
      adminActionSessions.set(sessionKey, {
        id: "ZZZ222",
        task: "external_share_link",
        fields: {},
        requester: {
          email: "member@example.com",
          identity: { channel: "matrix", requesterMatrixUserId: "@member:threads.example" },
        },
        createdAt: Date.now(),
        status: "approved",
      });
      try {
        const result = plugin().hook("before_tool_call")(
          { toolName: "exec", params: { command: "x" } } as never,
          { agentId: "cellect-fi-admin", sessionKey } as never,
        );
        expect(result).toMatchObject({ block: true });
      } finally {
        adminActionSessions.delete(sessionKey);
      }
    });
  });
}
