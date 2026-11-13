import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { expect, it, vi } from "vitest";
import type { FiUserMatrixEnvironmentHarness } from "./tools.matrix-environment.test-support.js";

type Harness = Pick<FiUserMatrixEnvironmentHarness, "calls" | "context" | "json" | "routes"> & {
  mocks: { execFile: ReturnType<typeof vi.fn> };
  plugin: () => { tool: (name: string, context: OpenClawPluginToolContext) => AnyAgentTool };
};

export function registerGmailUploadTests({ calls, context, json, mocks, plugin, routes }: Harness) {
  it("files the selected own Gmail attachment into Library without a room or another mailbox", async () => {
    let tempDir = "";
    mocks.execFile.mockImplementationOnce(async (_binary, args: string[]) => {
      expect(args.slice(0, 2)).toEqual(["user", "member@example.com"]);
      expect(args).toContain("message123");
      tempDir = args[args.indexOf("targetfolder") + 1];
      await fs.writeFile(path.join(tempDir, "Permit.pdf"), "%PDF-original");
      await fs.writeFile(path.join(tempDir, "image.jpg"), "signature logo");
      return { stdout: "saved", stderr: "" };
    });
    routes.push((url, init) => {
      if (url.pathname === "/api/shape/24-bright/docs/upload") {
        expect(authorization(init)).toBe("Bearer delegated-token");
        const form = init.body as FormData;
        expect(form.get("provenanceSource")).toBe("gmail");
        expect(form.get("provenanceMessageId")).toBe("message123");
        expect(form.get("provenanceFileId")).toBe("Permit.pdf");
        expect(form.get("provenanceUrl")).toBeNull();
        return (form.get("file") as File).text().then((text) => {
          expect(text).toBe("%PDF-original");
          return json({ duplicate: true, document: { documentId: "existing-doc" } });
        });
      }
      return undefined;
    });
    const result = await plugin().tool("fi_user_dataroom", context()).execute("gmail-library", {
      action: "upload_to_project_library",
      source: "gmail",
      project: "24-bright",
      messageId: "message123",
      attachmentName: "permit.pdf",
    });
    expect(result.details).toMatchObject({
      duplicate: true,
      document: { documentId: "existing-doc" },
    });
    expect(calls.some((entry) => entry.url.includes("/datarooms"))).toBe(false);
    await expect(fs.stat(tempDir)).rejects.toThrow();
  });

  it("keeps real project permission denials and cleans Gmail bytes without an admin fallback", async () => {
    let tempDir = "";
    mocks.execFile.mockImplementationOnce(async (_binary, args: string[]) => {
      tempDir = args[args.indexOf("targetfolder") + 1];
      await fs.writeFile(path.join(tempDir, "Permit.pdf"), "%PDF-original");
      return { stdout: "saved", stderr: "" };
    });
    routes.push((url) =>
      url.pathname.endsWith("/docs/upload")
        ? json({ error: "forbidden", message: "project grant required" }, 403)
        : undefined,
    );
    await expect(
      plugin().tool("fi_user_dataroom", context()).execute("denied", {
        action: "upload_to_project_library",
        source: "gmail",
        project: "24-bright",
        messageId: "message123",
      }),
    ).rejects.toThrow(/403|forbidden|grant required/);
    expect(calls.filter((entry) => entry.url.endsWith("/docs/upload"))).toHaveLength(1);
    await expect(fs.stat(tempDir)).rejects.toThrow();
  });

  it.each(["library", "room"])(
    "refuses ambiguous Gmail attachments and cleans up for %s filing",
    async (destination) => {
      let tempDir = "";
      mocks.execFile.mockImplementationOnce(async (_binary, args: string[]) => {
        tempDir = args[args.indexOf("targetfolder") + 1];
        await fs.writeFile(path.join(tempDir, "One.pdf"), "%PDF-one");
        await fs.writeFile(path.join(tempDir, "Two.pdf"), "%PDF-two");
        return { stdout: "saved", stderr: "" };
      });
      await expect(
        plugin()
          .tool("fi_user_dataroom", context())
          .execute("ambiguous", {
            ...(destination === "library"
              ? { action: "upload_to_project_library", source: "gmail", project: "24-bright" }
              : { action: "upload_gmail_attachment", roomId: "room-1" }),
            messageId: "message123",
          }),
      ).rejects.toThrow(/provide attachmentName/);
      expect(
        calls.some((entry) => entry.init.method === "POST" && entry.url.endsWith("upload")),
      ).toBe(false);
      await expect(fs.stat(tempDir)).rejects.toThrow();
    },
  );
}
