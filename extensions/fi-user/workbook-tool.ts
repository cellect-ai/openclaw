import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { brokerToken, configFromRuntime, matrixConnection, pathSegment } from "./fi-delegation.js";
import type { MatrixEntitlements } from "./matrix-entitlements.js";

type WorkbookTurn = NonNullable<ReturnType<MatrixEntitlements["workbookTurn"]>>;

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
const workbookSchema = Type.Union([readSchema, importSchema]);

/** Gateway-held API adapter. No credential is returned to the model or shell. */
export function createWorkbookTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext<2>,
  turn: WorkbookTurn,
): AnyAgentTool {
  return {
    name: "fi_workbook",
    label: "Fi workbook",
    description:
      "Read a room's native Univer workbook as the current verified Matrix requester. Returns a bounded tab summary and optional cell range with its collaboration revision. Import tabs only from a document already registered in the same room, preserving current sheets. First preview with dryRun true. Reuse the exact operationId, source checksum and collaboration revision on retry; reconcile unknown outcomes before another attempt. Never generates an operation key or retries automatically. No tenant, actor, URL, method or credentials may be supplied.",
    parameters: workbookSchema,
    async execute(_id, raw, signal) {
      context.assertInvocationCurrent();
      turn.assertCurrent();
      if (!Value.Check(workbookSchema, raw)) {
        throw new Error("Invalid workbook operation");
      }
      const input = raw as Static<typeof workbookSchema>;
      const importing = input.action === "import-tabs";
      pathSegment(input.roomId, "roomId");
      pathSegment(input.fieldId, "fieldId");
      const config = configFromRuntime(api);
      if (
        config.operatorAgentId !== "cellect-main" ||
        config.tenantOrgId ||
        config.tenantOrgConflict
      ) {
        throw new Error("Workbook requester scope unavailable");
      }
      const connection = matrixConnection(config, turn.accountId);
      const token = connection && brokerToken(connection);
      if (!connection || !token) {
        throw new Error("Workbook requester scope unavailable");
      }
      const { roomId, eventId, threadRootEventId, senderMxid, accountId, runId, sessionKey } = turn;
      const abort = AbortSignal.any([
        turn.signal,
        AbortSignal.timeout(importing ? 90_000 : 30_000),
        ...(signal ? [signal] : []),
      ]);
      abort.throwIfAborted();
      turn.assertCurrent();
      let response: Response;
      try {
        response = await fetch(`${connection.baseUrl}/api/threads/workbook`, {
          method: "POST",
          signal: abort,
          redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            action: input.action,
            target: { roomId: input.roomId, fieldId: input.fieldId },
            proof: { roomId, eventId, threadRootEventId, senderMxid, accountId, runId, sessionKey },
            ...(importing
              ? {
                  sourceDocumentId: input.sourceDocumentId,
                  sourceSha256: input.sourceSha256,
                  collabSessionId: input.collabSessionId,
                  expectedCollabRevision: input.expectedCollabRevision,
                  roomVersion: input.roomVersion,
                  operationId: input.operationId,
                  ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
                }
              : input.range !== undefined
                ? { range: input.range }
                : {}),
          }),
        });
      } catch (error) {
        if (importing) {
          throw new Error(
            `Workbook import outcome unconfirmed for operation ${input.operationId}; reconcile that exact operation before retrying`,
            { cause: error },
          );
        }
        throw error;
      }
      turn.assertCurrent();
      context.assertInvocationCurrent();
      abort.throwIfAborted();
      if (!response.ok && !importing) {
        throw new Error(`Workbook API refused or unavailable (${response.status})`);
      }
      const responseError = (message: string) =>
        new Error(
          importing
            ? `Workbook import outcome unconfirmed for operation ${input.operationId}; reconcile that exact operation before retrying (${message})`
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
      turn.assertCurrent();
      context.assertInvocationCurrent();
      abort.throwIfAborted();
      if (
        (importing
          ? result.operationId !== input.operationId ||
            result.automaticRetry !== false ||
            !["preview", "accepted", "unconfirmed"].includes(String(result.outcome))
          : result.ok !== true) ||
        result.orgId !== turn.orgId ||
        result.sheet?.fieldId !== input.fieldId
      ) {
        throw responseError("Workbook response does not match this native turn");
      }
      return jsonResult(result);
    },
  };
}
