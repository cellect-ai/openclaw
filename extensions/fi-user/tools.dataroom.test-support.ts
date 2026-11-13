import { describe, expect, it } from "vitest";
import { fiUserApiPath, fiUserApiRefusal } from "./fi-api-tool.js";
import {
  registerGmailUploadTests,
  type GmailUploadHarness,
} from "./tools.gmail-upload.test-support.js";

export function registerDataRoomTests(
  harness: GmailUploadHarness & {
    bodyJson: (init: RequestInit | undefined) => Record<string, unknown>;
  },
) {
  const { bodyJson, calls, context, json, mocks, plugin, routes } = harness;
  const authorization = (init: RequestInit) => new Headers(init.headers).get("authorization");
  describe("fi_user_dataroom", () => {
    const room = {
      roomVersion: 7,
      documents: [
        { documentId: "doc-1", roomCategory: "Draw 3", orderKey: "010", visibility: "shared" },
      ],
      tasks: [{ id: "task-1", documentIds: ["doc-0"] }],
    };

    it("continues a large authorized placement read and retrieves exact details without an admin action", async () => {
      const large = {
        ...room,
        documents: Array.from({ length: 90 }, (_, i) => ({
          documentId: `doc-${i}`,
          displayName: `Document ${i}`,
          roomCategory: i === 89 ? "Lorenzo KYC" : "Overview",
          orderKey: `01.${i}`,
          visibility: "internal",
        })),
        tasks: [{ id: "pfs", title: "PFS", documentIds: ["doc-89"], status: "open" }],
      };
      routes.push((url, init) =>
        url.pathname === "/api/shape/datarooms/room-1" && (init.method ?? "GET") === "GET"
          ? json(large)
          : undefined,
      );
      const tool = plugin().tool("fi_user_dataroom", context());
      let result = await tool.execute("placement", {
        action: "get",
        roomId: "room-1",
        view: "placement",
      });
      let page = result.details as { nextCursor?: string; complete: boolean; tasks: unknown[] };
      expect(page.complete).toBe(false);
      while (page.nextCursor) {
        result = await tool.execute("placement", {
          action: "get",
          roomId: "room-1",
          view: "placement",
          cursor: page.nextCursor,
        });
        page = result.details as typeof page;
      }
      expect(page.complete).toBe(true);
      expect(page.tasks).toContainEqual(large.tasks[0]);
      const exact = await tool.execute("detail", {
        action: "get",
        roomId: "room-1",
        documentId: "doc-89",
      });
      expect(exact.details).toMatchObject({ document: large.documents[89] });
      expect(calls.filter((call) => !call.url.endsWith("/openclaw-user-delegation"))).toSatisfy(
        (values: typeof calls) => values.every((call) => (call.init.method ?? "GET") === "GET"),
      );
      expect(mocks.subagentRun).not.toHaveBeenCalled();
    });

    it("offers only the reviewed actions: no generic pass-through, members, recipients or public links", () => {
      const schema = plugin().tool("fi_user_dataroom", context()).parameters as {
        properties: { action: { enum?: string[]; anyOf?: Array<{ const: string }> } };
      };
      const actions =
        schema.properties.action.enum ??
        schema.properties.action.anyOf?.map((entry) => entry.const) ??
        [];
      expect(actions).toEqual([
        "create",
        "list",
        "get",
        "tasks",
        "available_docs",
        "add_document",
        "update_document",
        "link_task",
        "complete_task",
        "upload_gmail_attachment",
        "upload_slack_file",
        "upload_drive_file",
        "upload_generated_artifact",
        "upload_file",
        "upload_to_project_library",
      ]);
      expect(JSON.stringify(schema)).not.toMatch(/"method"|"path"|jsonBody/);
    });

    it("adds a document with room-version preconditions, then reads it back", async () => {
      routes.push((url, init) => {
        if (url.pathname === "/api/shape/datarooms/room-1" && (init.method ?? "GET") === "GET") {
          return json(room);
        }
        if (url.pathname === "/api/shape/datarooms/room-1/documents" && init.method === "POST") {
          return json({ ok: true, roomVersion: 8 });
        }
        if (
          url.pathname === "/api/shape/datarooms/room-1/documents/doc-1" &&
          init.method === "PATCH"
        ) {
          return json({ ok: true, roomVersion: 9 });
        }
        return undefined;
      });
      const result = await plugin().tool("fi_user_dataroom", context()).execute("d1", {
        action: "add_document",
        roomId: "room-1",
        documentId: "doc-1",
        section: "Draw 3",
        orderKey: "010",
      });
      const post = calls.find(
        (entry) => entry.init.method === "POST" && entry.url.endsWith("/documents"),
      );
      const headers = new Headers(post!.init.headers);
      expect(headers.get("if-match")).toBe("7");
      expect(headers.get("idempotency-key")).toMatch(/^fi-user:[a-f0-9]{48}$/);
      expect(bodyJson(post!.init)).toEqual({ documentId: "doc-1" });
      const patch = calls.find((entry) => entry.init.method === "PATCH");
      expect(bodyJson(patch!.init)).toEqual({
        roomCategory: "Draw 3",
        orderKey: "010",
      });
      expect(result.details).toMatchObject({
        added: "doc-1",
        document: { documentId: "doc-1", roomCategory: "Draw 3" },
      });
    });

    it("links a checklist task by merging, never replacing, its documents", async () => {
      routes.push((url, init) => {
        if (url.pathname === "/api/shape/datarooms/room-1" && (init.method ?? "GET") === "GET") {
          return json(room);
        }
        if (
          url.pathname === "/api/shape/datarooms/room-1/tasks/task-1" &&
          init.method === "PATCH"
        ) {
          return json({ ok: true });
        }
        return undefined;
      });
      await plugin().tool("fi_user_dataroom", context()).execute("d2", {
        action: "link_task",
        roomId: "room-1",
        taskId: "task-1",
        documentId: "doc-1",
      });
      const patch = calls.find((entry) => entry.init.method === "PATCH");
      expect(bodyJson(patch!.init)).toEqual({ documentIds: ["doc-0", "doc-1"] });
    });

    it("rejects a room id that tries to reach another route", async () => {
      await expect(
        plugin()
          .tool("fi_user_dataroom", context())
          .execute("d3", { action: "get", roomId: "room-1/members" }),
      ).rejects.toThrow(/single identifier/);
    });

    function slackFile(
      user: string,
      shares: Record<string, Array<{ ts?: string; thread_ts?: string }>>,
    ) {
      return {
        ok: true,
        file: {
          id: "F0FILE0001",
          name: "Encotech contract.pdf",
          user,
          size: 10,
          url_private_download:
            "https://files.slack.com/files-pri/T1-F0FILE0001/download/encotech.pdf",
          permalink: "https://example.slack.com/files/U12345678/F0FILE0001",
          shares: { private: shares },
        },
      };
    }

    it("uploads a Slack file the requester posted in this thread, with Slack provenance", async () => {
      routes.push((url, init) => {
        if (url.hostname === "slack.com" && url.pathname === "/api/files.info") {
          expect(authorization(init)).toBe("Bearer xoxb-fi-user");
          return json(
            slackFile("U12345678", {
              C0CHANNEL1: [{ ts: "1710000000.000200", thread_ts: "1710000000.000100" }],
            }),
          );
        }
        if (url.hostname === "files.slack.com") {
          return new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } });
        }
        if (url.pathname === "/api/shape/datarooms/room-1" && (init.method ?? "GET") === "GET") {
          return json(room);
        }
        if (url.pathname === "/api/shape/datarooms/room-1/documents/upload") {
          return json({ ok: true, document: { documentId: "doc-9" }, roomVersion: 8 });
        }
        return undefined;
      });
      const result = await plugin().tool("fi_user_dataroom", context()).execute("d4", {
        action: "upload_slack_file",
        source: "gmail",
        roomId: "room-1",
        slackFileId: "F0FILE0001",
      });
      const upload = calls.find((entry) => entry.url.endsWith("/documents/upload"));
      const form = upload!.init.body as FormData;
      expect(form.get("provenanceSource")).toBe("slack");
      expect(form.get("provenanceFileId")).toBe("F0FILE0001");
      expect(form.get("provenanceMessageId")).toBe("1710000000.000100");
      expect((form.get("file") as File).name).toBe("Encotech contract.pdf");
      expect(authorization(upload!.init)).toBe("Bearer delegated-token");
      expect(result.details).toMatchObject({ documentId: "doc-9" });
    });

    it("refuses a Slack file posted by someone else", async () => {
      routes.push((url) =>
        url.pathname === "/api/files.info"
          ? json(
              slackFile("UOTHER0001", {
                C0CHANNEL1: [{ ts: "1", thread_ts: "1710000000.000100" }],
              }),
            )
          : undefined,
      );
      await expect(
        plugin().tool("fi_user_dataroom", context()).execute("d5", {
          action: "upload_slack_file",
          roomId: "room-1",
          slackFileId: "F0FILE0001",
        }),
      ).rejects.toThrow(/not posted by you/);
    });

    it("files a Slack file the requester posted into a project's document library, with provenance", async () => {
      routes.push((url, init) => {
        if (url.hostname === "slack.com" && url.pathname === "/api/files.info") {
          return json(
            slackFile("U12345678", {
              C0CHANNEL1: [{ ts: "1710000000.000200", thread_ts: "1710000000.000100" }],
            }),
          );
        }
        if (url.hostname === "files.slack.com") {
          return new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } });
        }
        if (url.pathname === "/api/shape/24-bright/docs/upload" && init.method === "POST") {
          return json({
            ok: true,
            duplicate: false,
            projectSlug: "24-bright",
            document: { documentId: "doc-lib", state: "restricted_unclassified" },
          });
        }
        return undefined;
      });
      const result = await plugin().tool("fi_user_dataroom", context()).execute("d7", {
        action: "upload_to_project_library",
        project: "24-bright",
        category: "construction",
        section: "Permits",
        slackFileId: "F0FILE0001",
      });
      const upload = calls.find((entry) => entry.url.endsWith("/docs/upload"));
      expect(upload!.url).toBe("https://fi.example.test/api/shape/24-bright/docs/upload");
      expect(authorization(upload!.init)).toBe("Bearer delegated-token");
      const form = upload!.init.body as FormData;
      expect(form.get("category")).toBe("construction");
      expect(form.get("section")).toBe("Permits");
      expect(form.get("provenanceSource")).toBe("slack");
      expect(form.get("provenanceFileId")).toBe("F0FILE0001");
      expect(form.get("provenanceMessageId")).toBe("1710000000.000100");
      expect(form.get("provenanceUrl")).toBe(
        "https://example.slack.com/files/U12345678/F0FILE0001",
      );
      expect((form.get("file") as File).name).toBe("Encotech contract.pdf");
      // No data room is touched.
      expect(calls.some((entry) => entry.url.includes("/datarooms"))).toBe(false);
      expect(result.details).toMatchObject({
        project: "24-bright",
        duplicate: false,
        document: { documentId: "doc-lib" },
      });
    });

    registerGmailUploadTests({ calls, context, json, mocks, plugin, routes });

    it("reports an unsupported document route with canonical recovery instead of invented admin access", () => {
      expect(
        fiUserApiRefusal(401, "/api/shape/24-bright/documents/text", { error: "bearer_rejected" }),
      ).toMatch(/not proof that an admin is required/);
      expect(fiUserApiPath("shape", "24-bright/docs/text")).toBe("/api/shape/24-bright/docs/text");
    });

    it("refuses a library upload of a Slack file posted by someone else, before any Fi write", async () => {
      routes.push((url) =>
        url.pathname === "/api/files.info"
          ? json(
              slackFile("UOTHER0001", {
                C0CHANNEL1: [{ ts: "1", thread_ts: "1710000000.000100" }],
              }),
            )
          : undefined,
      );
      await expect(
        plugin().tool("fi_user_dataroom", context()).execute("d8", {
          action: "upload_to_project_library",
          project: "24-bright",
          slackFileId: "F0FILE0001",
        }),
      ).rejects.toThrow(/not posted by you/);
      expect(calls.some((entry) => entry.url.endsWith("/docs/upload"))).toBe(false);
    });

    it("requires a single project slug for a library upload", async () => {
      for (const project of [undefined, "24-bright/../other", "a/b"]) {
        await expect(
          plugin()
            .tool("fi_user_dataroom", context())
            .execute("d9", {
              action: "upload_to_project_library",
              ...(project ? { project } : {}),
              slackFileId: "F0FILE0001",
            }),
        ).rejects.toThrow(/project must be a single identifier/);
      }
      expect(calls.some((entry) => entry.url.includes("slack.com"))).toBe(false);
    });

    it("refuses a Slack file from another conversation", async () => {
      routes.push((url) =>
        url.pathname === "/api/files.info"
          ? json(
              slackFile("U12345678", {
                C0ELSEWHERE: [{ ts: "1", thread_ts: "1710000000.000100" }],
              }),
            )
          : undefined,
      );
      await expect(
        plugin().tool("fi_user_dataroom", context()).execute("d6", {
          action: "upload_slack_file",
          roomId: "room-1",
          slackFileId: "F0FILE0001",
        }),
      ).rejects.toThrow(/not posted in this conversation/);
    });
  });
}
