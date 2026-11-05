import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { pathSegment } from "./fi-delegation.js";
import type { WorkbookTransport } from "./workbook-transport.js";

const readSchema = Type.Object(
  {
    action: Type.Literal("get"),
    roomId: Type.String({ minLength: 1, maxLength: 200 }),
    fieldId: Type.String({ minLength: 1, maxLength: 200 }),
    range: Type.Optional(
      Type.Object(
        {
          sheetId: Type.String({ minLength: 1, maxLength: 200 }),
          startRow: Type.Integer({ minimum: 0, maximum: 1000000 }),
          startColumn: Type.Integer({ minimum: 0, maximum: 1000000 }),
          rows: Type.Integer({ minimum: 1, maximum: 20 }),
          columns: Type.Integer({ minimum: 1, maximum: 20 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const importSchema = Type.Object(
  {
    action: Type.Literal("import-tabs"),
    roomId: Type.String({ minLength: 1, maxLength: 200 }),
    fieldId: Type.String({ minLength: 1, maxLength: 200 }),
    sourceDocumentId: Type.String({
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    }),
    sourceSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    collabSessionId: Type.String({
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    }),
    expectedCollabRevision: Type.Integer({ minimum: 0 }),
    roomVersion: Type.Integer({ minimum: 0 }),
    operationId: Type.String({ pattern: "^[A-Za-z0-9._:-]{16,200}$" }),
    dryRun: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const editSchema = Type.Object(
  {
    action: Type.Literal("edit"),
    roomId: Type.String({ minLength: 1, maxLength: 200 }),
    fieldId: Type.String({ minLength: 1, maxLength: 200 }),
    collabSessionId: Type.String({
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    }),
    expectedCollabRevision: Type.Integer({ minimum: 0 }),
    roomVersion: Type.Integer({ minimum: 0 }),
    operationId: Type.String({ pattern: "^[A-Za-z0-9._:-]{16,200}$" }),
    dryRun: Type.Optional(Type.Boolean()),
    mutations: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 200 }),
          params: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
const createSchema = Type.Object(
  {
    action: Type.Literal("create"),
    roomId: Type.String({ minLength: 1, maxLength: 200 }),
    displayName: Type.String({ minLength: 1, maxLength: 240 }),
    visibility: Type.Optional(Type.Union([Type.Literal("internal"), Type.Literal("shared")])),
    roomVersion: Type.Integer({ minimum: 0 }),
    operationId: Type.String({ pattern: "^[A-Za-z0-9._:-]{16,200}$" }),
    workbook: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
const workbookSchema = Type.Union([readSchema, importSchema, editSchema, createSchema]);

function operationBody(input: Static<typeof workbookSchema>) {
  const { action: _action, roomId: _roomId, ...body } = input;
  if ("fieldId" in body) {
    const { fieldId: _fieldId, ...operation } = body;
    return operation;
  }
  return body;
}

/** Gateway-held API adapter. No credential is returned to the model or shell. */
export function createWorkbookTool(
  context: OpenClawPluginToolContext<2>,
  transport: WorkbookTransport,
): AnyAgentTool {
  return {
    name: "fi_workbook",
    label: "Fi workbook",
    description:
      "Read, create, import or edit a room workbook through the authenticated API as the current verified requester. Get returns a bounded tab summary, optional cell range, unitId and collaboration revision. Edit submits native Univer mutations (including cell values, formatting and structure) to the same collaboration owner as the editor; use the returned unitId in mutation params. Import tabs only from a document registered in the same room. Create accepts native Univer workbook data or an empty workbook, default visibility internal. Preview edits/imports with dryRun true. Preserve the exact operationId and payload on retry; reconcile unknown outcomes before another attempt. No automatic retries. No tenant, actor, URL, method or credentials may be supplied.",
    parameters: workbookSchema,
    async execute(_id, raw, signal) {
      context.assertInvocationCurrent();
      transport.assertCurrent();
      if (!Value.Check(workbookSchema, raw)) {
        throw new Error("Invalid workbook operation");
      }
      const input = raw as Static<typeof workbookSchema>;
      const writing = input.action !== "get";
      pathSegment(input.roomId, "roomId");
      if (input.action !== "create") {
        pathSegment(input.fieldId, "fieldId");
      }
      const abort = AbortSignal.any([
        ...(transport.signal ? [transport.signal] : []),
        AbortSignal.timeout(writing ? 90_000 : 30_000),
        ...(signal ? [signal] : []),
      ]);
      abort.throwIfAborted();
      transport.assertCurrent();
      const authorized = await transport.authorize(abort);
      transport.assertCurrent();
      let response: Response;
      try {
        response = await fetch(authorized.url, {
          method: "POST",
          signal: abort,
          redirect: "error",
          headers: {
            authorization: `Bearer ${authorized.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: input.action,
            target: {
              roomId: input.roomId,
              ...(input.action !== "create" ? { fieldId: input.fieldId } : {}),
            },
            ...(authorized.proof ? { proof: authorized.proof } : {}),
            ...operationBody(input),
          }),
        });
      } catch (error) {
        if (writing) {
          throw new Error(
            `Workbook write outcome unconfirmed for operation ${input.operationId}; reconcile that exact operation before retrying`,
            { cause: error },
          );
        }
        throw error;
      }
      transport.assertCurrent();
      context.assertInvocationCurrent();
      abort.throwIfAborted();
      if (!response.ok && !writing) {
        throw new Error(`Workbook API refused or unavailable (${response.status})`);
      }
      const responseError = (message: string) =>
        new Error(
          writing
            ? `Workbook write outcome unconfirmed for operation ${input.operationId}; reconcile that exact operation before retrying (${message})`
            : message,
        );
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw responseError("response unavailable");
      }
      if (Buffer.byteLength(text, "utf8") > 32 * 1024) {
        throw responseError("Workbook API response too large; request a smaller range");
      }
      let result: {
        ok?: unknown;
        orgId?: unknown;
        operationId?: unknown;
        outcome?: unknown;
        automaticRetry?: unknown;
        sheet?: { fieldId?: unknown };
      };
      try {
        result = JSON.parse(text) as typeof result;
      } catch {
        throw responseError("Invalid workbook API response");
      }
      transport.assertCurrent();
      context.assertInvocationCurrent();
      abort.throwIfAborted();
      if (
        (writing
          ? result.operationId !== input.operationId ||
            result.automaticRetry !== false ||
            !["preview", "accepted", "rejected", "unconfirmed"].includes(String(result.outcome))
          : result.ok !== true) ||
        result.orgId !== authorized.orgId ||
        (input.action === "create"
          ? result.outcome === "accepted" &&
            (typeof result.sheet?.fieldId !== "string" || !result.sheet.fieldId)
          : result.sheet?.fieldId !== input.fieldId)
      ) {
        throw responseError("Workbook response does not match this native turn");
      }
      return jsonResult(result);
    },
  };
}
