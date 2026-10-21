import { describe, expect, it } from "vitest";
import { roomPlacementPage } from "./dataroom-placement.js";

describe("bounded requester placement inventory", () => {
  const snapshot = {
    roomVersion: 8,
    room: { name: "Diligence", noticeText: "large private notice" },
    documents: Array.from({ length: 80 }, (_, i) => ({
      documentId: `doc-${i}`,
      displayName: `Document ${i}`,
      roomCategory: i === 79 ? "Lorenzo KYC" : "Overview",
      orderKey: `01.${i}`,
      visibility: "internal",
      previewPdfPath: "/private/internal.pdf",
    })),
    tasks: [{ id: "pfs-task", title: "Lorenzo PFS", documentIds: ["doc-79"], status: "open" }],
  };

  it("reaches late sections and checklist links without dropping items or exposing file paths", () => {
    let page = roomPlacementPage("room-1", snapshot);
    const documents = [...page.documents];
    const tasks = [...page.tasks];
    let pages = 1;
    while (page.nextCursor) {
      expect(page.complete).toBe(false);
      expect(JSON.stringify(page)).not.toContain("/private/");
      page = roomPlacementPage("room-1", snapshot, page.nextCursor);
      documents.push(...page.documents);
      tasks.push(...page.tasks);
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(page.complete).toBe(true);
    expect(documents).toHaveLength(80);
    expect(new Set(documents.map((doc) => doc.documentId)).size).toBe(80);
    expect(documents.at(-1)).toMatchObject({ roomCategory: "Lorenzo KYC" });
    expect(tasks).toEqual(snapshot.tasks);
  });

  it("cannot stitch a cursor into another room, a changed version or altered inventory", () => {
    const cursor = roomPlacementPage("room-1", snapshot).nextCursor!;
    for (const [room, value] of [
      ["other-room", snapshot],
      ["room-1", { ...snapshot, roomVersion: 9 }],
      ["room-1", { ...snapshot, documents: snapshot.documents.slice(1) }],
    ] as const) {
      expect(() => roomPlacementPage(room, value, cursor)).toThrow(/Restart get/);
    }
    expect(() => roomPlacementPage("room-1", snapshot, "rp1_bad")).toThrow(/invalid/);
  });

  it("marks abbreviated detail explicitly and refuses a falsely complete inventory", () => {
    const page = roomPlacementPage("room-1", {
      documents: [{ documentId: "doc", displayName: "x".repeat(500), tags: Array(50).fill("tag") }],
      tasks: [],
    });
    expect(page.documents[0]).toMatchObject({ detailsTruncated: true });
    expect(page.documents[0].displayName).toHaveLength(300);
    expect(() => roomPlacementPage("room-1", { documents: [] })).toThrow(/incomplete/);
  });
});
