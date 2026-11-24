import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient, MatrixRawEvent } from "../sdk.js";
import { downloadMatrixMessageAttachment } from "./media.js";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  assertCurrent: vi.fn(),
  beforeCopy: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/file-access-runtime")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const workspace = await actual.root(...args);
      return {
        copyIn: async (...copyArgs: Parameters<typeof workspace.copyIn>) => {
          mocks.beforeCopy();
          return await workspace.copyIn(...copyArgs);
        },
      };
    },
  };
});
vi.mock("../monitor/media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../monitor/media.js")>()),
  downloadMatrixMedia: mocks.download,
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  captureChannelReadAuthority: () => mocks.assertCurrent,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
describe("authorized Matrix attachment retrieval", () => {
  beforeEach(() => vi.resetAllMocks());

  async function fixture() {
    const directory = dirs.make("matrix-download-");
    const filePath = path.join(directory, "original.png");
    await mkdir(path.join(directory, "workspace"));
    const bytes = createSolidPngBuffer(4, 3, { r: 30, g: 160, b: 40 });
    await writeFile(filePath, bytes);
    mocks.download.mockResolvedValue({ path: filePath, contentType: "image/png" });
    const event: MatrixRawEvent = {
      event_id: "$image",
      room_id: "!room:example.test",
      sender: "@person:example.test",
      type: "m.room.message",
      origin_server_ts: 1,
      content: {
        msgtype: "m.image",
        body: "original.png",
        url: "mxc://example.test/original",
        info: { mimetype: "image/png", size: bytes.length },
      },
    };
    const getEvent = vi.fn(async () => event);
    const context = {
      cfg: {},
      params: { url: "mxc://forged/secret" },
      mediaAccess: { workspaceDir: path.join(directory, "workspace") },
    } as unknown as ChannelMessageActionContext;
    const params = {
      client: { getEvent } as unknown as MatrixClient,
      roomId: "!room:example.test",
      messageId: event.event_id,
      mediaMaxMb: 200,
      context,
      original: false,
    };
    return { params, event, getEvent, bytes };
  }

  it("reopens an earlier image and stages byte-identical original bytes inside the agent workspace", async () => {
    const h = await fixture();
    const result = await downloadMatrixMessageAttachment(h.params);
    expect(h.getEvent).toHaveBeenCalledWith("!room:example.test", "$image");
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({
        mxcUrl: "mxc://example.test/original",
        maxBytes: 200 * 1024 * 1024,
      }),
    );
    expect(result.content.some((item) => item.type === "image")).toBe(true);
    expect(result.details).toMatchObject({
      ok: true,
      messageId: "$image",
      original: true,
      // The shared image-result helper intentionally reports its local absolute
      // source; original-only JSON keeps a relative outbound-routing reference.
      media: {
        mediaUrl: path.join(
          h.params.context.mediaAccess!.workspaceDir!,
          "media/inbound/original.png",
        ),
        outbound: false,
      },
    });
    expect(
      await readFile(
        path.join(h.params.context.mediaAccess!.workspaceDir!, "media/inbound/original.png"),
      ),
    ).toEqual(h.bytes);
  });

  it("can return the original file without a model image preview", async () => {
    const h = await fixture();
    const result = await downloadMatrixMessageAttachment({ ...h.params, original: true });
    expect(result.content.some((item) => item.type === "image")).toBe(false);
    expect(result.details).toMatchObject({ ok: true, size: h.bytes.length });
  });

  it.each(["redacted", "wrong-room", "wrong-event", "external-url", "text", "text-with-url"])(
    "refuses %s media without downloading",
    async (failure) => {
      const h = await fixture();
      if (failure === "redacted") h.event.unsigned = { redacted_because: {} };
      if (failure === "wrong-room") h.event.room_id = "!other:example.test";
      if (failure === "wrong-event") h.event.event_id = "$other";
      if (failure === "external-url") h.event.content.url = "https://internal.example/private";
      if (failure === "text") h.event.content = { msgtype: "m.text", body: "hello" };
      if (failure === "text-with-url")
        h.event.content = { msgtype: "m.text", body: "hello", url: "mxc://example.test/other" };
      await expect(downloadMatrixMessageAttachment(h.params)).rejects.toThrow();
      expect(mocks.download).not.toHaveBeenCalled();
    },
  );

  it("rechecks live requester authority after fetching the event", async () => {
    const h = await fixture();
    h.getEvent.mockImplementationOnce(async () => {
      mocks.assertCurrent.mockImplementation(() => {
        throw new Error("requester revoked");
      });
      return h.event;
    });
    await expect(downloadMatrixMessageAttachment(h.params)).rejects.toThrow("requester revoked");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("does not publish a staged path or image after authority is revoked during download", async () => {
    const h = await fixture();
    mocks.download.mockImplementationOnce(async () => {
      mocks.assertCurrent.mockImplementation(() => {
        throw new Error("requester revoked");
      });
      return { path: "not-visible", contentType: "image/png" };
    });
    await expect(downloadMatrixMessageAttachment(h.params)).rejects.toThrow("requester revoked");
  });

  it("guards the workspace copy's mutation boundary against a revocation during staging", async () => {
    const h = await fixture();
    mocks.beforeCopy.mockImplementationOnce(() => {
      mocks.assertCurrent.mockImplementation(() => {
        throw new Error("requester revoked during copy");
      });
    });
    await expect(downloadMatrixMessageAttachment(h.params)).rejects.toThrow(
      "requester revoked during copy",
    );
    const staged = path.join(
      h.params.context.mediaAccess!.workspaceDir!,
      "media/inbound/original.png",
    );
    await expect(access(staged)).rejects.toThrow();
  });
});
