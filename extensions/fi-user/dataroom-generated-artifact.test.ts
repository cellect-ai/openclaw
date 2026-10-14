import { createHash } from "node:crypto";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exchange: vi.fn(), delegatedJson: vi.fn(), read: vi.fn() }));
vi.mock("./fi-delegation.js", async (original) => ({
  ...(await original<typeof import("./fi-delegation.js")>()),
  exchange: mocks.exchange,
  delegatedJson: mocks.delegatedJson,
}));
vi.mock("./generated-artifacts.js", () => ({ readGeneratedArtifact: mocks.read }));
import { createDataRoomTool } from "./dataroom-tool.js";

const bytes = Buffer.from("budget,line\nconcrete,100\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const provenance = { artifactId: "ga_fixture", sha256, sessionId: "session-fixture" };
const filingProvenance = { source: "generated_artifact", ...provenance };
const context = { sessionKey: "session-fixture" } as OpenClawPluginToolContext;
const api = {} as OpenClawPluginApi;
const tool = () => createDataRoomTool(api, context);
const libraryInput = {
  action: "upload_to_project_library",
  project: "24-bright",
  artifactId: provenance.artifactId,
};
const roomInput = {
  action: "upload_generated_artifact",
  roomId: "room-1",
  artifactId: provenance.artifactId,
  visibility: "internal",
  section: "Budget",
  orderKey: "02.01",
  displayName: "Budget.csv",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exchange.mockResolvedValue({
    config: {},
    identity: {},
    delegation: { user: { email: "member@example.test", orgSlug: "shape" } },
  });
  mocks.read.mockResolvedValue({
    bytes,
    fileName: "Budget.csv",
    sha256,
    mimeType: "text/csv",
    provenance,
  });
  mocks.delegatedJson.mockImplementation(async (_config, _delegation, pathname, init) => {
    if (pathname.endsWith("/docs/upload")) {
      return {
        projectSlug: "24-bright",
        document: { documentId: "doc-1" },
        filingReceipt: {
          documentId: "doc-1",
          sha256,
          projectSlug: "24-bright",
          provenance: filingProvenance,
        },
      };
    }
    if (pathname.endsWith("/documents/upload")) {
      return {
        document: { documentId: "doc-1" },
        filingReceipt: {
          documentId: "doc-1",
          sha256,
          provenance: filingProvenance,
        },
      };
    }
    if (init.method === "GET") {
      return {
        roomVersion: 3,
        documents: [
          {
            documentId: "doc-1",
            displayName: "Budget.csv",
            roomCategory: "Budget",
            orderKey: "02.01",
            visibility: "internal",
          },
        ],
      };
    }
    return {};
  });
});

describe("generated-artifact filing through requester tools", () => {
  it("files verified immutable bytes in the project library with generated provenance and persisted receipt", async () => {
    const result = await tool().execute("library", libraryInput);
    expect(mocks.read).toHaveBeenCalledWith(api, context, provenance.artifactId);
    const call = mocks.delegatedJson.mock.calls.find((entry) => entry[2].endsWith("/docs/upload"))!;
    expect(call[2]).toBe("/api/shape/24-bright/docs/upload");
    const form = call[3].body as FormData;
    expect(form.get("provenanceSource")).toBe("generated_artifact");
    expect(form.get("provenanceArtifactId")).toBe(provenance.artifactId);
    expect(form.get("provenanceSha256")).toBe(sha256);
    expect(form.get("provenanceSessionId")).toBe(provenance.sessionId);
    expect(Buffer.from(await (form.get("file") as File).arrayBuffer())).toEqual(bytes);
    expect(result.details).toMatchObject({
      document: { documentId: "doc-1" },
      filingReceipt: { sha256 },
    });
  });

  it("uses existing room grants, byte-bound idempotency, explicit placement and authoritative membership readback", async () => {
    const result = await tool().execute("room", roomInput);
    const upload = mocks.delegatedJson.mock.calls.find((entry) =>
      entry[2].endsWith("/documents/upload"),
    )!;
    expect(upload[3].headers).toMatchObject({
      "if-match": "3",
      "idempotency-key": expect.stringMatching(/^fi-user:/),
    });
    expect((upload[3].body as FormData).get("visibility")).toBe("internal");
    expect(mocks.delegatedJson.mock.calls.some((entry) => entry[3].method === "PATCH")).toBe(true);
    expect(result.details).toMatchObject({
      documentId: "doc-1",
      document: { roomCategory: "Budget", orderKey: "02.01", visibility: "internal" },
    });
  });

  it("refuses cross-requester or cross-session artifacts before any Fi filing", async () => {
    mocks.read.mockRejectedValue(new Error("Artifact does not belong to this requester/session"));
    await expect(tool().execute("foreign", libraryInput)).rejects.toThrow(/requester\/session/);
    expect(mocks.delegatedJson).not.toHaveBeenCalled();
  });

  it("does not substitute administrator authority when the destination denies the requester", async () => {
    mocks.delegatedJson.mockRejectedValue(new Error("Fi project library upload failed (403)"));
    await expect(tool().execute("denied", libraryInput)).rejects.toThrow(/403/);
    expect(mocks.delegatedJson).toHaveBeenCalledTimes(1);
  });

  it("does not claim completion from a missing or mismatched persisted library receipt", async () => {
    mocks.delegatedJson.mockResolvedValue({
      document: { documentId: "doc-1" },
      filingReceipt: { documentId: "doc-1", sha256: "wrong", provenance },
    });
    await expect(tool().execute("unverified", libraryInput)).rejects.toThrow(
      /did not confirm its persisted filing receipt/,
    );
  });

  it("refuses duplicate content when persisted provenance belongs to another source", async () => {
    mocks.delegatedJson.mockResolvedValue({
      duplicate: true,
      document: { documentId: "doc-1" },
      filingReceipt: { documentId: "doc-1", sha256, provenance: { source: "slack" } },
    });
    await expect(tool().execute("duplicate", libraryInput)).rejects.toThrow(
      /persisted filing receipt/,
    );
  });

  it("accepts an exact-artifact duplicate receipt without writing a second copy", async () => {
    mocks.delegatedJson.mockResolvedValue({
      duplicate: true,
      document: { documentId: "doc-1" },
      filingReceipt: { documentId: "doc-1", sha256, provenance: filingProvenance },
    });
    expect((await tool().execute("duplicate", libraryInput)).details).toMatchObject({
      duplicate: true,
    });
  });

  it("refuses missing room membership readback instead of claiming a completed filing", async () => {
    mocks.delegatedJson.mockImplementation(async (_config, _delegation, pathname) =>
      pathname.endsWith("/documents/upload")
        ? { document: { documentId: "doc-1" }, filingReceipt: { documentId: "doc-1", sha256 } }
        : { roomVersion: 3, documents: [] },
    );
    await expect(tool().execute("unconfirmed", roomInput)).rejects.toThrow(
      /membership could not be verified/,
    );
  });

  it("refuses a placement readback that differs from the requested visibility", async () => {
    mocks.delegatedJson.mockImplementation(async (_config, _delegation, pathname) =>
      pathname.endsWith("/documents/upload")
        ? { document: { documentId: "doc-1" }, filingReceipt: { documentId: "doc-1", sha256 } }
        : {
            roomVersion: 3,
            documents: [
              {
                documentId: "doc-1",
                displayName: "Budget.csv",
                roomCategory: "Budget",
                orderKey: "02.01",
                visibility: "shared",
              },
            ],
          },
    );
    await expect(tool().execute("misplaced", roomInput)).rejects.toThrow(/placement did not match/);
  });

  it("refuses room filing when the persisted artifact or session receipt does not match", async () => {
    mocks.delegatedJson.mockImplementation(async (_config, _delegation, pathname, init) => {
      if (pathname.endsWith("/documents/upload"))
        return {
          document: { documentId: "doc-1" },
          filingReceipt: {
            documentId: "doc-1",
            sha256,
            provenance: {
              source: "generated_artifact",
              artifactId: "ga_other",
              sha256,
              sessionId: provenance.sessionId,
            },
          },
        };
      if (init.method === "GET") return { roomVersion: 3, documents: [] };
      return {};
    });
    await expect(tool().execute("bad-provenance", roomInput)).rejects.toThrow(
      /persisted content receipt/,
    );
  });

  it("requires explicit visibility and refuses mixed generated and Slack source arguments", async () => {
    await expect(
      tool().execute("visibility", { ...roomInput, visibility: undefined }),
    ).rejects.toThrow(/Choose shared or internal/);
    await expect(
      tool().execute("mixed", { ...libraryInput, slackFileId: "F0FILE0001" }),
    ).rejects.toThrow(/do not mix/);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.delegatedJson).not.toHaveBeenCalled();
  });
});
