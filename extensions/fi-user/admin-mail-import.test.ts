import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminActionSessions } from "./admin-action.js";
import {
  AUTHORIZE_URL,
  fetchMock,
  installDelegationFixtures,
  matrix,
  MATRIX_SESSION,
  minted,
  MINT_URL,
  mintBody,
  mints,
  plugin,
  SESSION,
  thread,
  THREAD,
  TOKEN,
} from "./admin-delegation.test-helpers.js";

installDelegationFixtures();

const IMPORT_URL = "https://fi.example.test/fi/api/a/documents/import";
const bytes = Buffer.from("%PDF-1.7 rent roll\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const importTo = {
  objectType: "project",
  objectSlug: "montgomery",
  category: "correspondence",
  dateDoc: "2026-10-28",
};
const file = {
  bytes,
  fileName: "Rent Roll.pdf",
  mimeType: "application/pdf",
  origin: {
    provider: "microsoft365",
    mailbox: "admin@example.com",
    messageId: "mail-12345",
    attachmentId: "attach-12345",
  },
};
const imported = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      ok: true,
      result: {
        applied: true,
        documentId: "doc-1",
        filename: "2026-10-28 Rent Roll.pdf",
        sha256,
        sizeBytes: bytes.length,
        owner: { type: "project", objectType: "project", objectSlug: "montgomery" },
        taxonomy: { category: "correspondence", family: "unclassified", type: "unclassified" },
        ocr: { state: "queued" },
        ...overrides,
      },
      warnings: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

type Handoff = {
  capture: (
    context: OpenClawPluginToolContext,
    request?: { importTo?: unknown },
  ) => { registerDownload: (input: typeof file) => Promise<Record<string, unknown>> };
};

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fi-admin-mail-import-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/** A Slack DM turn from the admin, already proven, and its tool context. */
async function provenTurn(contextOverrides: Partial<OpenClawPluginToolContext> = {}) {
  const turn = plugin();
  await turn.arrive();
  await turn.start();
  const handoff = turn.runtimeContext("slack", "fi-file-artifacts") as Handoff;
  const context = {
    runId: "run-1",
    agentId: "cellect-fi-admin",
    sessionKey: SESSION,
    sessionId: "session-1",
    messageChannel: "slack",
    requesterSenderId: "U0ADMIN001",
    workspaceDir: workspace,
    assertInvocationCurrent: vi.fn(),
    ...contextOverrides,
  } as OpenClawPluginToolContext;
  return { turn, handoff, context };
}

function respond(importReply: () => Response = () => imported()) {
  fetchMock.mockImplementation(async (url: string) =>
    url === MINT_URL
      ? minted()
      : url === IMPORT_URL
        ? importReply()
        : url === AUTHORIZE_URL
          ? new Response(JSON.stringify({ ok: true, agentId: "cellect-fi-admin", orgId: "org-a" }))
          : new Response("unexpected", { status: 500 }),
  );
}

const imports = () => fetchMock.mock.calls.filter(([url]) => url === IMPORT_URL);

describe("Fi-admin mail attachment import", () => {
  it("imports into Fi as the requester and keeps nothing in the shared workspace", async () => {
    respond();
    const { handoff, context } = await provenTurn();
    const result = await handoff.capture(context, { importTo }).registerDownload(file);
    expect(result).toMatchObject({
      status: "imported_to_fi",
      documentId: "doc-1",
      originalFileName: "Rent Roll.pdf",
      sha256,
      owner: { objectType: "project", objectSlug: "montgomery" },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(mintBody()).toEqual({ requesterSenderId: "U0ADMIN001", agentId: "cellect-fi-admin" });
    const [, init] = imports()[0]!;
    const request = init as RequestInit;
    expect(request.method).toBe("POST");
    expect(new Headers(request.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const form = request.body as FormData;
    expect([...form.keys()].toSorted()).toEqual(["file", "input"]);
    const sent = form.get("file") as File;
    expect(sent.name).toBe("Rent Roll.pdf");
    expect(Buffer.from(await sent.arrayBuffer())).toEqual(bytes);
    expect(JSON.parse(form.get("input") as string)).toEqual({
      actor: "admin@example.com",
      ...importTo,
      provenance: {
        source: "m365_mail_attachment",
        original_filename: "Rent Roll.pdf",
        message_id: "mail-12345",
        file_id: "attach-12345",
      },
    });
    expect(await fs.readdir(workspace)).toEqual([]);
  });

  it("asserts no provenance for a member importing on a document grant", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === MINT_URL ? minted({}, { role: "member" }) : imported(),
    );
    const { handoff, context } = await provenTurn();
    await handoff.capture(context, { importTo }).registerDownload(file);
    const input = JSON.parse((imports()[0]![1] as { body: FormData }).body.get("input") as string);
    expect(input).not.toHaveProperty("provenance");
  });

  it("imports for a proven Matrix requester under their own Matrix identity", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    await turn.arrive(matrix.arrive);
    await turn.start(matrix.start);
    respond();
    const handoff = turn.runtimeContext("matrix", "fi-file-artifacts") as Handoff;
    const result = await handoff
      .capture(
        {
          runId: "run-1",
          agentId: "cellect-fi-admin",
          sessionKey: MATRIX_SESSION,
          messageChannel: "matrix",
          requesterSenderId: "@admin:matrix.example",
          agentAccountId: "adminprod",
          assertInvocationCurrent: vi.fn(),
        } as OpenClawPluginToolContext,
        { importTo },
      )
      .registerDownload(file);
    expect(result.documentId).toBe("doc-1");
    expect(mintBody()).toEqual({
      requesterMatrixUserId: "@admin:matrix.example",
      agentId: "cellect-fi-admin",
    });
  });

  it.each([
    ["no destination", undefined],
    ["an unknown owner type", { ...importTo, objectType: "room" }],
    ["no document date", { ...importTo, dateDoc: undefined }],
    ["a filename date without its basis", { ...importTo, filenameDate: "2026-10" }],
    [
      "a free-text filename date basis",
      { ...importTo, dateDoc: undefined, filenameDate: "2026-10", filenameDateBasis: "it is" },
    ],
    ["an impossible date", { ...importTo, dateDoc: "2026-02-31" }],
    ["a path as the category", { ...importTo, category: "../docs" }],
  ])("refuses %s before anything is downloaded", async (_name, destination) => {
    respond();
    const { handoff, context } = await provenTurn();
    const before = fetchMock.mock.calls.length;
    expect(() => handoff.capture(context, { importTo: destination })).toThrow(
      "Nothing was downloaded or imported",
    );
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it.each([
    ["a run it never proved", { runId: "run-2" }],
    ["another person", { requesterSenderId: "U0OTHER002" }],
    ["another session", { sessionKey: `${SESSION}9` }],
  ])("refuses %s before anything is downloaded", async (_name, overrides) => {
    respond();
    const { handoff, context } = await provenTurn(overrides);
    const before = fetchMock.mock.calls.length;
    expect(() => handoff.capture(context, { importTo })).toThrow("verified requester");
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it("does not import once the run has ended", async () => {
    respond();
    const { turn, handoff, context } = await provenTurn();
    const files = handoff.capture(context, { importTo });
    await turn.settle();
    await expect(files.registerDownload(file)).rejects.toThrow("no longer verified");
    expect(imports()).toEqual([]);
  });

  it("does not import for an invocation the host retired", async () => {
    respond();
    const retired = vi.fn(() => {
      throw new Error("Invocation retired");
    });
    const { handoff, context } = await provenTurn();
    const files = handoff.capture(context, { importTo });
    context.assertInvocationCurrent = retired;
    await expect(files.registerDownload(file)).rejects.toThrow("Invocation retired");
    expect(imports()).toEqual([]);
  });

  it("imports for an admitted voice turn's speaker only", async () => {
    vi.stubEnv("FI_THREADS_ENV_BY_ACCOUNT", JSON.stringify({ adminprod: "prod" }));
    const turn = plugin();
    await turn.start({
      ...thread().start,
      channelContext: {
        sender: { id: "@admin:matrix.example" },
        chat: { id: "!room:matrix.example", talkThreadRootEventId: "$root" },
      },
    });
    respond();
    const handoff = turn.runtimeContext("matrix", "fi-file-artifacts") as Handoff;
    const voice = (requesterSenderId: string) =>
      ({
        runId: "run-1",
        agentId: "cellect-fi-admin",
        sessionKey: THREAD,
        messageChannel: "matrix",
        requesterSenderId,
        agentAccountId: "adminprod",
        assertInvocationCurrent: vi.fn(),
      }) as OpenClawPluginToolContext;
    expect(() => handoff.capture(voice("@other:matrix.example"), { importTo })).toThrow(
      "verified requester",
    );
    const result = await handoff
      .capture(voice("@admin:matrix.example"), { importTo })
      .registerDownload(file);
    expect(result.documentId).toBe("doc-1");
  });

  it("does not import once another person writes in the session during the download", async () => {
    respond();
    const { turn, handoff, context } = await provenTurn();
    const files = handoff.capture(context, { importTo });
    await turn.arrive({ senderId: "U0OTHER002", messageId: "1792190999.000002" });
    await expect(files.registerDownload(file)).rejects.toThrow("verified");
    expect(imports()).toEqual([]);
  });

  it("does not import from an approved admin action's session", async () => {
    const sessionKey = "agent:cellect-fi-admin:admin-action:zzz333";
    adminActionSessions.set(sessionKey, {
      id: "ZZZ333",
      task: "external_share_link",
      fields: {},
      requester: {
        email: "admin@example.com",
        identity: { channel: "slack", requesterSenderId: "U0ADMIN001" },
      },
      createdAt: Date.now(),
      status: "approved",
    });
    try {
      respond();
      const turn = plugin();
      await turn.arrive({ sessionKey });
      await turn.start({ sessionKey });
      const handoff = turn.runtimeContext("slack", "fi-file-artifacts") as Handoff;
      expect(() =>
        handoff.capture(
          {
            runId: "run-1",
            agentId: "cellect-fi-admin",
            sessionKey,
            messageChannel: "slack",
            requesterSenderId: "U0ADMIN001",
            assertInvocationCurrent: vi.fn(),
          } as OpenClawPluginToolContext,
          { importTo },
        ),
      ).toThrow("verified requester");
      expect(mints()).toEqual([]);
    } finally {
      adminActionSessions.delete(sessionKey);
    }
  });

  it("tells Fi-admin to update an older mail plugin before anything is downloaded", async () => {
    respond();
    const { handoff, context } = await provenTurn();
    expect(() => handoff.capture(context)).toThrow("until it is updated");
  });

  it("refuses a Fi destination for Fi-user, which files through its data room", async () => {
    respond();
    const { handoff, context } = await provenTurn({ agentId: "cellect-fi-user" });
    expect(() => handoff.capture(context, { importTo })).toThrow("omit importTo");
  });

  it.each([
    ["the request fails", () => Promise.reject(new TypeError("fetch failed"))],
    ["a gateway times out", () => new Response("upstream timeout", { status: 504 })],
    ["Fi answers without JSON", () => new Response("<html>ok</html>", { status: 200 })],
  ])("treats an import as unconfirmed when %s", async (_name, reply) => {
    respond(reply as () => Response);
    const { handoff, context } = await provenTurn();
    await expect(handoff.capture(context, { importTo }).registerDownload(file)).rejects.toThrow(
      "Look the file up in Fi before retrying",
    );
  });

  it("does not take an ambiguous owner for a file Fi already holds", async () => {
    respond(
      () =>
        new Response(
          JSON.stringify({
            error: "montgomery names two projects in a; give the project id",
            code: "conflict",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    const { handoff, context } = await provenTurn();
    await expect(handoff.capture(context, { importTo }).registerDownload(file)).rejects.toThrow(
      "Fi refused the import (409): montgomery names two projects",
    );
  });

  it("reports bytes Fi already holds instead of importing them again", async () => {
    respond(
      () =>
        new Response(
          JSON.stringify({
            error: "This file is already registered in a as document doc-0",
            code: "conflict",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    const { handoff, context } = await provenTurn();
    expect(await handoff.capture(context, { importTo }).registerDownload(file)).toMatchObject({
      status: "already_in_fi",
      documentId: "doc-0",
    });
  });

  it("does not claim an import Fi did not confirm for these bytes", async () => {
    respond(() => imported({ sha256: "0".repeat(64) }));
    const { handoff, context } = await provenTurn();
    await expect(handoff.capture(context, { importTo }).registerDownload(file)).rejects.toThrow(
      "did not confirm",
    );
  });

  it("names Fi's refusal without retrying", async () => {
    respond(
      () =>
        new Response(JSON.stringify({ error: "forbidden", code: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const { handoff, context } = await provenTurn();
    await expect(handoff.capture(context, { importTo }).registerDownload(file)).rejects.toThrow(
      "Fi refused the import (403): forbidden",
    );
    expect(imports()).toHaveLength(1);
  });

  it("still refuses other agents", async () => {
    respond();
    const { handoff, context } = await provenTurn({ agentId: "cellect-main" });
    expect(() => handoff.capture(context, { importTo })).toThrow(
      "available only to Fi-user and Fi-admin",
    );
  });
});
