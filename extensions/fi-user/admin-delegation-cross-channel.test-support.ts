import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZE_URL,
  matrix,
  HELD,
  UNPROVEN_HOLD,
  SLACK_THREAD,
  slackThread,
  plugin,
  fetchMock,
  minted,
  mints,
  sendText,
} from "./admin-delegation.test-helpers.js";

/** A Fi token whose payload names `sub` in org `a`, as Fi signs them. */
export const fiToken = (sub: string, tag = "sig") =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub, org_slug: "a", agent_id: "cellect-fi-admin" })).toString("base64url")}.${tag}`;

export const ADMIN_SLACK = fiToken("admin@example.com", "slack");

const ADMIN_MATRIX = fiToken("Admin@Example.com", "matrix");

const OTHER_MATRIX = fiToken("other@example.com", "other");

const PROJECTION = "!projection:matrix.example";

export const CROSS = { crossChannelCustody: true };

export function registerCrossChannelCustodyCases() {
  describe("one person's sandbox hold across two channels (G-B3)", () => {
    beforeEach(() => {
      vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
      // Fi mints for whoever the request names; the Matrix admission gate answers ok.
      fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
        if (url === AUTHORIZE_URL) {
          return new Response(
            JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
          );
        }
        const body = JSON.parse(init?.body ?? "{}") as Record<string, string>;
        return body.requesterMatrixUserId === "@other:matrix.example"
          ? minted({ token: OTHER_MATRIX }, { email: "other@example.com" })
          : body.requesterMatrixUserId
            ? minted({ token: ADMIN_MATRIX })
            : minted({ token: ADMIN_SLACK });
      });
    });

    /** A reply typed in the Slack thread's Matrix projection, admitted by Fi's source guard. */
    const projected = (senderId = "@admin:matrix.example", eventId = "$reply") => {
      const channelContext = {
        sender: { id: senderId },
        chat: {
          id: PROJECTION,
          eventId,
          sourceReplyAdmission: {
            version: 1,
            sessionKey: SLACK_THREAD,
            roomId: PROJECTION,
            senderId,
            accountId: "adminprod",
            eventId,
            authorizedAt: Date.now(),
          },
        },
      };
      return {
        arrive: {
          channel: "matrix",
          accountId: "adminprod",
          senderId,
          sessionKey: SLACK_THREAD,
          isGroup: true,
          messageId: eventId,
          channelContext,
        },
        start: {
          runId: "run-m",
          channel: "matrix",
          senderId,
          sessionKey: SLACK_THREAD,
          accountId: "adminprod",
          channelContext: { sender: { id: senderId }, chat: { id: PROJECTION, eventId } },
        },
        exec: {
          runId: "run-m",
          sessionKey: SLACK_THREAD,
          requester: { channel: "matrix", senderId, accountId: "adminprod" },
        },
      };
    };

    /** The admin's Slack command holds the agent's sandbox; its run has ended. */
    const afterSlackCommand = async (config: Record<string, unknown> = CROSS) => {
      const turn = plugin(config);
      const slack = slackThread();
      await turn.arrive(slack.arrive);
      await turn.start(slack.start);
      const first = await turn.exec(slack.exec);
      expect(first?.params.env?.FI_DELEGATED_USER_TOKEN).toBeDefined();
      await turn.settle();
      return turn;
    };

    it("lets the same person's Matrix reply in the same session run with its own token", async () => {
      const turn = await afterSlackCommand();
      const reply = projected();
      await turn.arrive(reply.arrive);
      await turn.start(reply.start);
      const result = await turn.exec(reply.exec);
      expect(result?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(ADMIN_MATRIX);
      expect(JSON.parse(String(mints().at(-1)?.[1]?.body))).toMatchObject({
        requesterMatrixUserId: "@admin:matrix.example",
      });
      // Only a minted token proves the subject: the same run's other sandbox tools stay held.
      expect(
        await turn.exec({ ...reply.exec, toolName: "read" }, { toolName: "read", params: {} }),
      ).toEqual({ block: true, blockReason: HELD });
    });

    it("holds a different person on Matrix and never injects the token Fi minted for them", async () => {
      const turn = await afterSlackCommand();
      const reply = projected("@other:matrix.example");
      await turn.arrive(reply.arrive);
      await turn.start(reply.start);
      const before = mints().length;
      const result = await turn.exec(reply.exec);
      expect(result).toEqual({ block: true, blockReason: HELD });
      expect(JSON.stringify(result)).not.toContain(OTHER_MATRIX);
      // The one extra mint the plan accepts; its token is dropped.
      expect(mints()).toHaveLength(before + 1);
    });

    it("holds the same person in a different session without asking Fi", async () => {
      const turn = await afterSlackCommand();
      await turn.arrive(matrix.arrive);
      await turn.start({ ...matrix.start, runId: "run-dm" });
      const before = mints().length;
      expect(await turn.exec({ ...matrix.exec, runId: "run-dm" })).toEqual({
        block: true,
        blockReason: HELD,
      });
      expect(mints()).toHaveLength(before);
    });

    it("holds a tool that does not mint without asking Fi", async () => {
      const turn = await afterSlackCommand();
      const reply = projected();
      await turn.arrive(reply.arrive);
      await turn.start(reply.start);
      const before = mints().length;
      expect(
        await turn.exec({ ...reply.exec, toolName: "write" }, { toolName: "write", params: {} }),
      ).toEqual({ block: true, blockReason: HELD });
      expect(mints()).toHaveLength(before);
    });

    it("holds an unproven run without asking Fi", async () => {
      const turn = await afterSlackCommand();
      await turn.start({
        runId: "cron-1",
        sessionKey: SLACK_THREAD,
        trigger: "cron",
        senderId: undefined,
      });
      const before = mints().length;
      expect(
        await turn.exec({ runId: "cron-1", sessionKey: SLACK_THREAD, requester: undefined }),
      ).toEqual({ block: true, blockReason: UNPROVEN_HOLD });
      expect(mints()).toHaveLength(before);
    });

    it("treats a holder whose token named no subject as a mismatch", async () => {
      fetchMock.mockImplementation(async (url: string, init?: { body?: string }) =>
        url === AUTHORIZE_URL
          ? new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }))
          : JSON.parse(init?.body ?? "{}").requesterMatrixUserId
            ? minted({ token: ADMIN_MATRIX })
            : minted(),
      );
      const turn = await afterSlackCommand();
      const reply = projected();
      await turn.arrive(reply.arrive);
      await turn.start(reply.start);
      const result = await turn.exec(reply.exec);
      expect(result).toEqual({ block: true, blockReason: HELD });
      expect(JSON.stringify(result)).not.toContain(ADMIN_MATRIX);
    });

    it("holds when another person's holder replaced the sandbox while Fi answered", async () => {
      const turn = await afterSlackCommand();
      const reply = projected();
      await turn.arrive(reply.arrive);
      await turn.start(reply.start);
      let answer!: (response: Response) => void;
      fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
        if (url === AUTHORIZE_URL) {
          return new Response(
            JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
          );
        }
        const body = JSON.parse(init?.body ?? "{}") as Record<string, string>;
        return body.requesterMatrixUserId
          ? new Promise<Response>((resolve) => {
              answer = resolve;
            })
          : minted({ token: OTHER_MATRIX }, { email: "other@example.com" });
      });
      const pending = turn.exec(reply.exec);
      await vi.waitFor(() => expect(answer).toBeDefined());
      // The admin's command finishes; someone else's command takes the sandbox.
      await turn.cleanup({ sessionKey: SLACK_THREAD });
      const other = {
        sessionKey: "agent:cellect-fi-admin:slack:direct:u0other002",
        senderId: "U0OTHER002",
      };
      await turn.arrive(other);
      await turn.start({ ...other, runId: "run-o" });
      expect(
        (
          await turn.exec({
            runId: "run-o",
            sessionKey: other.sessionKey,
            requester: { channel: "slack", senderId: "U0OTHER002" },
          })
        )?.params.env?.FI_DELEGATED_USER_TOKEN,
      ).toBe(OTHER_MATRIX);
      answer(minted({ token: ADMIN_MATRIX }));
      const result = await pending;
      expect(result?.block).toBe(true);
      expect(JSON.stringify(result)).not.toContain(ADMIN_MATRIX);
    });

    it("holds a minting-tool candidate that gets no token, with no token or assertion", async () => {
      const turn = await afterSlackCommand();
      const reply = projected();
      await turn.arrive(reply.arrive);
      await turn.start(reply.start);
      const before = mints().length;
      // Raw shell work is never pinned, so no token is asked for.
      const result = await turn.exec(reply.exec, { params: { command: "env | sort" } });
      expect(result).toEqual({ block: true, blockReason: HELD });
      expect(JSON.stringify(result)).not.toContain("FI_DELEGATED_USER_TOKEN");
      expect(JSON.stringify(result)).not.toContain("FI_ON_BEHALF_OF");
      expect(mints()).toHaveLength(before);
    });

    it("matches nobody once the holder's own mints disagreed on the subject", async () => {
      let slackMints = 0;
      fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
        if (url === AUTHORIZE_URL) {
          return new Response(
            JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }),
          );
        }
        const body = JSON.parse(init?.body ?? "{}") as Record<string, string>;
        if (body.requesterMatrixUserId) {
          return minted({ token: ADMIN_MATRIX });
        }
        slackMints += 1;
        return minted({
          token: slackMints === 1 ? ADMIN_SLACK : fiToken("relinked@example.com", "second"),
        });
      });
      const turn = plugin(CROSS);
      const slack = slackThread();
      await turn.arrive(slack.arrive);
      await turn.start(slack.start);
      expect((await turn.exec(slack.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toBe(ADMIN_SLACK);
      // The holder's own run gets a token for another subject: its subject is cleared.
      expect((await turn.exec(slack.exec))?.params.env?.FI_DELEGATED_USER_TOKEN).toContain(
        ".second",
      );
      await turn.settle();
      const reply = projected();
      await turn.arrive(reply.arrive);
      await turn.start(reply.start);
      const result = await turn.exec(reply.exec);
      expect(result).toEqual({ block: true, blockReason: HELD });
      expect(JSON.stringify(result)).not.toContain(ADMIN_MATRIX);
    });

    it.each([
      ["off by default", {}],
      ["off unless exactly true", { crossChannelCustody: "true" }],
    ])("is today's behaviour when %s: held, and Fi is never asked", async (_name, config) => {
      const turn = await afterSlackCommand(config);
      const reply = projected();
      await turn.arrive(reply.arrive);
      await turn.start(reply.start);
      const before = mints().length;
      expect(await turn.exec(reply.exec)).toEqual({ block: true, blockReason: HELD });
      expect(mints()).toHaveLength(before);
      expect(sendText).not.toHaveBeenCalled();
    });
  });
}
