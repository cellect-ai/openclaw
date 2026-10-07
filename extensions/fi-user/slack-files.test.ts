import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_DRIVE_FILE_BYTES } from "./gam.js";
import { downloadSlackFile, MAX_SLACK_FILE_BYTES } from "./slack-files.js";

describe("document attachment limits", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts the 70 MB plan set and the 200 MB boundary without allocating large fixtures", async () => {
    expect(MAX_SLACK_FILE_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_DRIVE_FILE_BYTES).toBe(MAX_SLACK_FILE_BYTES);
    const fetchMock = vi.fn().mockImplementation(async () => new Response("original PDF bytes"));
    vi.stubGlobal("fetch", fetchMock);
    for (const size of [70_026_203, MAX_SLACK_FILE_BYTES]) {
      expect(
        await downloadSlackFile("synthetic", {
          id: "FSYNTHETIC",
          size,
          url_private_download: "https://files.slack.com/synthetic.pdf",
        }),
      ).toEqual(new TextEncoder().encode("original PDF bytes"));
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects metadata above 200 MB before downloading", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      downloadSlackFile("synthetic", {
        id: "FSYNTHETIC",
        size: MAX_SLACK_FILE_BYTES + 1,
        url_private_download: "https://files.slack.com/synthetic.pdf",
      }),
    ).rejects.toThrow("200 MB limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
