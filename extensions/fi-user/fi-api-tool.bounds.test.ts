import { describe, expect, it, vi } from "vitest";
import { readBoundedFiResponse } from "./fi-api-tool.js";

const PATH = "/api/shape/305-third/docs/doc-1/file";

describe("fi_user_api body bounds", () => {
  it("refuses a declared length over the cap without reading the body", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { "content-type": "text/html", "content-length": String(800_001) },
    });
    await expect(readBoundedFiResponse(response, PATH)).rejects.toThrow(
      `${PATH} is too large to read here; use fi_user_deliver_file`,
    );
    expect(cancel).toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
  });

  it("cancels an undeclared stream once it passes the cap", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let pulls = 0;
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(chunk);
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "text/plain" } },
    );
    await expect(readBoundedFiResponse(response, PATH, 256 * 1024)).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalled();
    // Four chunks fill the cap; the fifth passes it and ends the read.
    expect(pulls).toBeLessThanOrEqual(6);
  });

  it("returns text and parses JSON within the cap", async () => {
    expect(
      await readBoundedFiResponse(
        new Response("budget", { headers: { "content-type": "text/plain" } }),
        PATH,
      ),
    ).toBe("budget");
    expect(
      await readBoundedFiResponse(
        new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
        PATH,
      ),
    ).toEqual({ ok: true });
  });
});
