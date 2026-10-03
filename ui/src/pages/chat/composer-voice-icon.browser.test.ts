// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const styleFiles = [
  "ui/src/styles/base.css",
  "ui/src/styles/layout.css",
  "ui/src/styles/layout.mobile.css",
  "ui/src/styles/components.css",
  "ui/src/styles/chat/startup-layout.css",
  "ui/src/styles/chat/layout.css",
  "ui/src/styles/chat/message-layout.css",
  "ui/src/styles/chat/composer-surface.css",
  "ui/src/styles/chat/composer.css",
  "ui/src/styles/chat/composer-queue.css",
  "ui/src/styles/chat/progress-card.css",
  "ui/src/styles/chat/composer-progress.css",
  "ui/src/styles/chat/composer-context-strip.css",
  "ui/src/styles/chat/text.css",
  "ui/src/styles/chat/grouped.css",
  "ui/src/styles/chat/tool-cards.css",
  "ui/src/styles/chat/working-indicator.css",
  "ui/src/styles/chat/question-card.css",
  "ui/src/styles/rail-header.css",
  "ui/src/styles/chat/sidebar.css",
  "ui/src/styles/chat/session-rail.css",
  "ui/src/styles/chat/side-panel.css",
];
const uiCss = styleFiles.map((file) => readFileSync(path.join(repoRoot, file), "utf8")).join("\n");

const mic = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path class="icon-mic-capsule" d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><path d="M12 19v3"></path></svg>`;
const cameraOff = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l20 20"></path><path d="M14.5 4 16 7h3"></path></svg>`;

function pageHtml(width: number): string {
  return `<!doctype html><html data-theme-mode="light"><head><style>${uiCss}</style></head><body>
    <div class="agent-chat__composer-shell" style="width:${width}px">
      <footer class="agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar">
        <div class="agent-chat__composer-combobox"><textarea id="draft"></textarea></div>
        <div class="agent-chat__composer-footer">
          <div class="agent-chat__composer-actions">
            <span class="chat-talk-control">
              <button id="voice" class="chat-send-btn chat-send-btn--voice" type="button">${mic}</button>
            </span>
            <span class="chat-mobile-dictation-action">
              <span class="chat-talk-control">
                <button id="phone" class="chat-send-btn chat-send-btn--voice" type="button">${mic}</button>
              </span>
            </span>
            <button id="camera" class="chat-send-btn chat-send-btn--voice" type="button">${cameraOff}</button>
          </div>
        </div>
      </footer>
    </div>
    <span id="ink" style="color:var(--text-strong)"></span>
    <span id="quiet" style="color:var(--muted)"></span>
  </body></html>`;
}

async function readGlyph(page: Page, selector: string) {
  return await page.evaluate((selector) => {
    const svg = document.querySelector<SVGElement>(selector);
    if (!svg) {
      throw new Error(`Missing ${selector}`);
    }
    const paint = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        fill: style.fill,
        stroke: style.stroke,
        color: style.color,
        opacity: style.opacity,
      };
    };
    const paths = [...svg.querySelectorAll<SVGPathElement>("path")];
    const capsule = svg.querySelector<SVGPathElement>(".icon-mic-capsule");
    return {
      ink: getComputedStyle(document.querySelector("#ink")!).color,
      quiet: getComputedStyle(document.querySelector("#quiet")!).color,
      svg: paint(svg),
      capsule: capsule ? paint(capsule) : null,
      stands: paths.filter((path) => !path.classList.contains("icon-mic-capsule")).map(paint),
      slash: paths.some((path) => /[Mm]\s*2[\s,]2/.test(path.getAttribute("d") ?? "")),
      background: getComputedStyle(svg.closest("button")!).backgroundColor,
    };
  }, selector);
}

function expectSolidMic(glyph: Awaited<ReturnType<typeof readGlyph>>) {
  expect(glyph.slash).toBe(false);
  expect(glyph.svg.opacity).toBe("1");
  expect(glyph.svg.color).toBe(glyph.ink);
  expect(glyph.capsule?.fill).toBe(glyph.ink);
  expect(glyph.capsule?.stroke).toBe("none");
  expect(glyph.stands.length).toBeGreaterThan(0);
  for (const stand of glyph.stands) {
    expect(stand.fill).toBe("none");
  }
  expect(glyph.background).toBe("rgba(0, 0, 0, 0)");
}

describe("composer voice icon", () => {
  it.each([520, 800])("keeps a solid voice mark at %ipx through focus and blur", async (width) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
      await page.setContent(pageHtml(width));
      const assertSolid = async () => {
        expectSolidMic(await readGlyph(page, "#voice svg"));
        const camera = await readGlyph(page, "#camera svg");
        expect(camera.slash).toBe(true);
        for (const path of [camera.capsule, ...camera.stands]) {
          if (path) {
            expect(path.fill).toBe("none");
          }
        }
        if (width <= 560) {
          expect(camera.svg.color).toBe(camera.quiet);
        }
      };
      await assertSolid();
      await page.click("#draft");
      await assertSolid();
      await page.click("body");
      await assertSolid();
    } finally {
      await browser.close();
    }
  });

  it("keeps the phone dictation mic solid when the viewport is narrow", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
      await page.setContent(pageHtml(900));
      expectSolidMic(await readGlyph(page, "#phone svg"));
      await page.click("#draft");
      expectSolidMic(await readGlyph(page, "#phone svg"));
      await page.click("body");
      expectSolidMic(await readGlyph(page, "#phone svg"));
    } finally {
      await browser.close();
    }
  });
});
