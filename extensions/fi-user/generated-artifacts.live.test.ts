import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import JSZip from "jszip";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { completeSimple, type Message, type Model } from "openclaw/plugin-sdk/llm";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import fiUserPlugin from "./index.js";

// Release-only behavioral proof: real model, registered production tools and SQLite;
// synthetic delegation and attachment transport, never a user chat or business tenant.
// The bounded executor offers generic file/archive operations, not a workbook generator.
// Luna must author every CSV byte or Office XML package entry itself.
const enabled = process.env.FI_ARTIFACT_LIVE_TEST === "1";
const cases = [
  {
    id: "itemized",
    filename: "Itemized.xlsx",
    sheets: ["Items"],
    request:
      "Create an itemized budget XLSX: Concrete, quantity 10, unit price 20; Steel, quantity 3, unit price 50. Columns Item, Quantity, Unit price, Amount. Amount cells must be formulas multiplying quantity and unit price; total formula must sum amounts. Total is 350. Attach the workbook to me.",
  },
  {
    id: "subitems",
    filename: "Subitems.xlsx",
    sheets: ["Subitems"],
    request:
      "Create XLSX with worksheet Subitems. Parent Concrete has subitems Forms 100 and Pour 150. Parent Steel has subitem Framing 100. Include item-level amounts and formula subtotal/total rows. Total is 350. Attach the workbook to me.",
  },
  {
    id: "rfq",
    filename: "RFQ.csv",
    sheets: [],
    request:
      "Create RFQ.csv with header Item,Quantity,Unit,Notes and exactly two data rows: Steel framing,3,ton,Include delivery; Concrete,10,cy,Include pumping. Attach the CSV to me.",
  },
  {
    id: "g702-g703",
    filename: "Draw.xlsx",
    sheets: ["G702", "G703"],
    request:
      "Convert the supplied sanitized budget into Draw.xlsx with G702 and G703 worksheets. Source has Concrete 200 and Steel 150; completed this period Concrete 100 and Steel 50; retainage 10%. G703 must list scheduled values and this-period values. G702 must use formulas for contract sum 350, earned 150, retainage 15 and payment due 135. Attach workbook to me. Fixture source rows are supplied here; do not fetch or infer private project data.",
  },
] as const;

function objectDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || !("details" in value))
    throw new Error("Expected structured tool result");
  return value.details as Record<string, unknown>;
}
function safeName(value: string) {
  if (!value || value !== path.basename(value) || /[\\/\x00-\x1f]/.test(value))
    throw new Error("Use a filename, not a path");
  return value;
}
function safeEntry(value: string) {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new Error("Unsafe ZIP entry");
  return value;
}

describe.skipIf(!enabled)("Luna generated-artifact behavioral replay", () => {
  it.each(cases)(
    "$id: generates, registers and delivers actual output through the production factory",
    async (testCase) => {
      const apiKey = process.env.LITELLM_API_KEY;
      const apiBase = process.env.LITELLM_BASE_URL?.replace(/\/+$/, "");
      const modelId = process.env.FI_ARTIFACT_LIVE_MODEL ?? "openai/gpt-6-luna";
      if (!apiKey || !apiBase)
        throw new Error(
          "Live replay requires independently injected LITELLM_API_KEY and LITELLM_BASE_URL",
        );
      const routePin = process.env.FI_ARTIFACT_LIVE_ROUTE_PIN
        ? JSON.parse(process.env.FI_ARTIFACT_LIVE_ROUTE_PIN)
        : null;
      if (modelId === "balanced") {
        // The proxy exposes semantic aliases, and its response echoes the alias.
        // Backend identity is certified by the operator's before/after live-config
        // check, never by pi-ai's reply.model (which echoes our model object).
        expect(routePin).toMatchObject({
          alias: "balanced",
          providerModel: "openai/gpt-6-luna",
          deployments: 1,
          mode: "responses",
        });
        expect(routePin.containerId).toMatch(/^[a-f0-9]{64}$/);
        expect(routePin.configSha256).toMatch(/^[a-f0-9]{64}$/);
      } else if (!/(?:^|\/)gpt-6-luna$/.test(modelId))
        throw new Error("This replay requires the Luna route; no model substitution");
      const available = await fetch(`${apiBase}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!available.ok) throw new Error(`Model admission failed (${available.status})`);
      const catalog = (await available.json()) as { data?: Array<{ id?: string }> };
      if (!catalog.data?.some((entry) => entry.id === modelId))
        throw new Error("Luna is not available in this independently authorized model projection");

      const fixture = await createOpenClawTestState({
        label: `generated-luna-${testCase.id}`,
        applyEnv: true,
      });
      // Input fixture only; output package entries always come from the real model.
      const source = new JSZip();
      source.file(
        "[Content_Types].xml",
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      );
      source.file(
        "_rels/.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      );
      source.file(
        "xl/workbook.xml",
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
      );
      source.file(
        "xl/_rels/workbook.xml.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      );
      source.file(
        "xl/worksheets/sheet1.xml",
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Scheduled</t></is></c><c r="C1" t="inlineStr"><is><t>This period</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Concrete</t></is></c><c r="B2"><v>200</v></c><c r="C2"><v>100</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Steel</t></is></c><c r="B3"><v>150</v></c><c r="C3"><v>50</v></c></row></sheetData></worksheet>',
      );
      const sourceBytes = await source.generateAsync({ type: "nodebuffer" });
      const requester = "UFIXTURE01";
      const fixtureBrokerEnv = "FI_ARTIFACT_FIXTURE_BROKER_TOKEN";
      vi.stubEnv(fixtureBrokerEnv, "fixture-only-token");
      const server = http.createServer(async (req, res) => {
        if (
          req.url !== "/api/openclaw-user-delegation" ||
          req.method !== "POST" ||
          req.headers.authorization !== "Bearer fixture-only-token"
        ) {
          res.writeHead(403).end();
          return;
        }
        let body = "";
        for await (const part of req) body += String(part);
        const assertion = JSON.parse(body) as {
          requesterSenderId?: string;
          senderId?: string;
          agentId?: string;
        };
        if (
          assertion.agentId !== "cellect-fi-user" ||
          !(assertion.requesterSenderId === requester || assertion.senderId === requester)
        ) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            user: {
              email: "fixture@pentest.invalid",
              orgId: "fixture-org",
              orgSlug: "fixture",
              role: "member",
            },
            fi: {
              token: "fixture-only-delegation",
              expiresAt: Math.floor(Date.now() / 1000) + 600,
            },
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture broker unavailable");
      const config = {
        plugins: {
          entries: {
            "fi-user": {
              config: {
                baseUrl: `http://127.0.0.1:${address.port}`,
                brokerTokenEnv: fixtureBrokerEnv,
                tenantOrgId: "fixture-org",
              },
            },
          },
        },
      };
      const context = {
        agentId: "cellect-fi-user",
        messageChannel: "slack",
        requesterSenderId: requester,
        agentAccountId: "fi-user",
        workspaceDir: fixture.workspaceDir,
        sessionId: `fixture-${testCase.id}`,
        sessionKey: `agent:cellect-fi-user:slack:direct:${requester}`,
        getRuntimeConfig: () => config,
        assertInvocationCurrent: () => undefined,
      } as OpenClawPluginToolContext;
      const received: Array<{ bytes: Buffer; sha256: string; messageId: string }> = [];
      let outputDirectory: string | undefined;
      let registeredArtifact: string | undefined;
      const actions: string[] = [];
      let factory:
        | {
            contextVersion: 2;
            create: (context: OpenClawPluginToolContext) => AnyAgentTool[] | null;
          }
        | undefined;
      const api = createTestPluginApi({
        id: "fi-user",
        name: "Fi User Delegation",
        config,
        runtime: {
          state: {
            openKeyedStore: <T>(
              options: Parameters<typeof createPluginStateKeyedStoreForTests>[1],
            ) => createPluginStateKeyedStoreForTests<T>("fi-user", options),
          },
          channel: {
            runtimeContexts: { register: () => undefined },
            outbound: {
              loadAdapter: async () => ({
                sendMedia: async (params: {
                  to: string;
                  accountId?: string;
                  mediaUrl: string;
                  mediaReadFile?: (candidate: string) => Promise<Buffer>;
                }) => {
                  expect(params.to).toBe(`user:${requester}`);
                  expect(params.accountId).toBe("fi-user");
                  if (!params.mediaReadFile) throw new Error("No exact-byte reader");
                  const bytes = Buffer.from(await params.mediaReadFile(params.mediaUrl));
                  expect(bytes.length).toBeGreaterThan(0);
                  const messageId = `fixture-delivery-${received.length + 1}`;
                  received.push({
                    bytes,
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                    messageId,
                  });
                  return { messageId };
                },
              }),
            },
          },
        } as unknown as OpenClawPluginApi["runtime"],
        registerTool: (registration) => {
          if (typeof registration === "object" && "create" in registration)
            factory = registration as typeof factory;
        },
      });
      try {
        fiUserPlugin.register?.(api);
        expect(factory?.contextVersion).toBe(2);
        const delivery = factory
          ?.create(context)
          ?.find((tool) => tool.name === "fi_user_deliver_file");
        if (!delivery) throw new Error("Production delivery tool was not registered");
        const executor: AnyAgentTool = {
          name: "sandbox_exec",
          label: "Fixture file executor",
          description:
            "Bounded synthetic executor, no shell/network/process/env. Read supplied Source.xlsx with action=readzip and filename=Source.xlsx. Write model-authored file bytes with action=write, filename and text. Create a ZIP archive of model-authored entries with action=zip, filename, entries [{name,text}]. Names inside ZIP can use directories. The host does not supply output document XML or formulas. Writes only into the prepared output directory. For XLSX author a complete Office package yourself. No arbitrary paths.",
          parameters: Type.Object(
            {
              action: Type.Union([
                Type.Literal("write"),
                Type.Literal("zip"),
                Type.Literal("readzip"),
              ]),
              filename: Type.String(),
              text: Type.Optional(Type.String()),
              entries: Type.Optional(
                Type.Array(Type.Object({ name: Type.String(), text: Type.String() })),
              ),
            },
            { additionalProperties: false },
          ),
          execute: async (_id, raw) => {
            const input = raw as {
              action: "write" | "zip" | "readzip";
              filename: string;
              text?: string;
              entries?: Array<{ name: string; text: string }>;
            };
            const filename = safeName(input.filename);
            if (input.action === "readzip") {
              if (filename !== "Source.xlsx")
                throw new Error("Only the supplied source fixture may be read");
              const inputZip = await JSZip.loadAsync(sourceBytes);
              const entries = await Promise.all(
                Object.values(inputZip.files)
                  .filter((entry) => !entry.dir)
                  .map(async (entry) => ({
                    name: entry.name,
                    text: await entry.async("string"),
                  })),
              );
              actions.push("readzip");
              return jsonResult({ filename, entries });
            }
            if (!outputDirectory) throw new Error("Call fi_user_deliver_file prepare first");
            let bytes: Buffer;
            if (input.action === "zip") {
              if (!input.entries?.length || input.entries.length > 40)
                throw new Error("Archive requires 1–40 model-authored entries");
              const zip = new JSZip();
              for (const entry of input.entries) {
                if (entry.text.length > 200_000) throw new Error("Entry too large");
                zip.file(safeEntry(entry.name), entry.text);
              }
              bytes = await zip.generateAsync({ type: "nodebuffer" });
            } else bytes = Buffer.from(input.text ?? "");
            if (!bytes.length || bytes.length > 2_000_000)
              throw new Error("Output must contain 1–2000000 bytes");
            const boundary = await root(fixture.workspaceDir);
            await boundary.write(`${outputDirectory}/${filename}`, bytes);
            actions.push("sandbox_exec");
            return jsonResult({
              written: filename,
              bytes: bytes.length,
              next: "Validate the requested structure/arithmetic, then register and deliver.",
            });
          },
        };
        const tools = [delivery, executor];
        const model: Model<"openai-completions"> = {
          id: modelId,
          name: modelId,
          provider: "litellm",
          api: "openai-completions",
          baseUrl: apiBase,
          reasoning: true,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        const messages: Message[] = [
          {
            role: "user",
            content:
              testCase.request +
              ` Use filename ${testCase.filename}.` +
              (testCase.sheets.length
                ? ` Use these exact worksheet names: ${testCase.sheets.join(", ")}.`
                : "") +
              (testCase.id === "g702-g703"
                ? " Read the supplied Source.xlsx through sandbox_exec readzip before conversion."
                : ""),
            timestamp: Date.now(),
          },
        ];
        let final = "";
        let observedModel: string | undefined;
        for (let turn = 0; turn < 14; turn++) {
          const reply = await completeSimple(
            model,
            {
              systemPrompt:
                "You are Cellect Fi. Deliver generated files through the available tool. A saved file is not delivered. Never present internal filesystem paths as download links. Only report completion after a delivery receipt. The sandbox executor is a bounded fixture replacing shell execution; author the requested output yourself. Do not ask the requester to upload your inaccessible output.",
              messages,
              tools,
            },
            {
              apiKey,
              reasoning: "low",
              maxTokens: 16000,
              signal: AbortSignal.timeout(120000),
              onPayload: (payload) => {
                if (!payload || typeof payload !== "object")
                  throw new Error("Expected an HTTP request object");
                // This must reach LiteLLM itself; an SDK option would not disable
                // the proxy's fallback chain and could silently test another model.
                return { ...payload, disable_fallbacks: true };
              },
            },
          );
          if (reply.stopReason === "error" || reply.stopReason === "aborted")
            throw new Error("Live model call failed; no delivery proof");
          observedModel = reply.model;
          expect(reply.model).toBe(modelId);
          messages.push(reply);
          const calls = reply.content.filter((part) => part.type === "toolCall");
          if (!calls.length) {
            final = reply.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
            break;
          }
          for (const call of calls) {
            const tool = tools.find((candidate) => candidate.name === call.name);
            if (!tool) throw new Error("Model requested an unavailable tool");
            try {
              const result = await tool.execute(call.id, call.arguments);
              if (call.name === delivery.name) {
                const details = objectDetails(result);
                actions.push(String(call.arguments.action));
                if (details.outputDirectory)
                  outputDirectory = String(details.outputDirectory).replace(/^\/workspace\//, "");
                if (details.artifactId) registeredArtifact = String(details.artifactId);
              }
              messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: result.content,
                details: result.details,
                isError: false,
                timestamp: Date.now(),
              });
            } catch (error) {
              messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [
                  {
                    type: "text",
                    text: error instanceof Error ? error.message : "Fixture tool failed",
                  },
                ],
                isError: true,
                timestamp: Date.now(),
              });
            }
          }
        }
        expect(actions).toEqual(
          expect.arrayContaining(["prepare", "sandbox_exec", "register", "deliver"]),
        );
        expect(received).toHaveLength(1);
        const deliveredFile = received[0];
        if (!deliveredFile) throw new Error("The model did not deliver an artifact");
        if (process.env.FI_ARTIFACT_LIVE_OUTPUT_DIR) {
          const output = process.env.FI_ARTIFACT_LIVE_OUTPUT_DIR;
          if (!path.isAbsolute(output)) throw new Error("Proof output directory must be absolute");
          await fs.mkdir(output, { recursive: true, mode: 0o700 });
          await fs.writeFile(path.join(output, testCase.filename), deliveredFile.bytes, {
            mode: 0o600,
          });
        }
        expect(final).not.toMatch(/\/workspace\/|file:\/\/|\/tmp\//);
        expect(final.length).toBeGreaterThan(0);
        if (testCase.id === "g702-g703") expect(actions).toContain("readzip");
        if (testCase.id === "rfq") {
          const text = deliveredFile.bytes.toString("utf8");
          expect(text).toContain("Item,Quantity,Unit,Notes");
          expect(text).toContain("Steel framing,3,ton,Include delivery");
          expect(text).toContain("Concrete,10,cy,Include pumping");
        } else {
          const zip = await JSZip.loadAsync(deliveredFile.bytes);
          const workbook = await zip.file("xl/workbook.xml")?.async("string");
          for (const sheet of testCase.sheets) expect(workbook).toContain(`name="${sheet}"`);
          const sheets = Object.keys(zip.files).filter((name) =>
            /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
          );
          expect(sheets.length).toBe(testCase.sheets.length);
          const xml = (
            await Promise.all(sheets.map((name) => zip.file(name)!.async("string")))
          ).join("\n");
          const strings = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
          expect(xml).toContain("<f>");
          expect(xml + strings).toContain("Concrete");
          expect(xml + strings).toContain("Steel");
          // Numerical/cached formula values are inspected separately in the model replay receipt;
          // these assertions prove package/tabs/formula presence, not recalculation correctness.
        }
        if (!registeredArtifact) throw new Error("Model did not retain an artifact ID");
        resetPluginStateStoreForTests();
        const reopened = factory!.create(context)!.find((tool) => tool.name === delivery.name)!;
        const repeated = await reopened.execute("after-store-reopen", {
          action: "deliver",
          artifactId: registeredArtifact,
        });
        expect(objectDetails(repeated)).toMatchObject({
          reusedReceipt: true,
          messageId: deliveredFile.messageId,
        });
        expect(received).toHaveLength(1);
        console.log(
          JSON.stringify({
            replay: testCase.id,
            requestedModel: modelId,
            observedModel,
            reasoning: "low",
            backendIdentity: routePin
              ? { evidence: "operator_live_config_pin", ...routePin }
              : null,
            fallbacksDisabled: true,
            actions,
            sha256: deliveredFile.sha256,
            bytes: deliveredFile.bytes.length,
            transport: "fixture_slack_sink",
            sqliteReceiptReopen: "passed",
            semanticArithmetic: "not_certified",
          }),
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        resetPluginStateStoreForTests();
        vi.unstubAllEnvs();
        await fixture.cleanup();
      }
    },
    300000,
  );
});
