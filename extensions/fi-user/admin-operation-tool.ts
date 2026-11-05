import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { registerAdminDelegation } from "./admin-delegation.js";
import { delegatedFetch, FI_ADMIN_DELEGATION_AGENT_ID, lookupDelegation } from "./fi-delegation.js";

type Requester = NonNullable<
  ReturnType<ReturnType<typeof registerAdminDelegation>["provenToolRequester"]>
>;
type JsonRecord = Record<string, unknown>;
const operation = Type.String({
  pattern: "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$",
  maxLength: 200,
});
const variant = Type.String({ pattern: "^[a-z][a-z0-9-]*$", maxLength: 80 });
const schema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("discover"),
      operation: Type.Optional(operation),
      variant: Type.Optional(variant),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("execute"),
      operation,
      variant,
      input: Type.Record(Type.String(), Type.Unknown()),
      dryRun: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);
const FILE_UNSUPPORTED =
  "This typed tool does not transfer files. Use the existing requester-bound CLI or verified artifact workflow for this variant; never supply a gateway or sandbox file path here.";
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Compare identity and environment, never just a person who may exist in both environments. */
function identity(proof: Requester): string {
  return JSON.stringify({
    body: proof.body,
    baseUrl: proof.connection.baseUrl,
    brokerTokenEnv: proof.connection.brokerTokenEnv,
    tenantOrgId: proof.connection.tenantOrgId,
    tenantOrgConflict: proof.connection.tenantOrgConflict,
    adminAgentId: proof.connection.adminAgentId,
  });
}

function filelessSupport(row: JsonRecord): { supported: boolean; reason?: string } {
  const arrays = [row.localFiles, row.outputFiles, row.requiredOutputs];
  if (
    !(row.file === null || isRecord(row.file)) ||
    !isRecord(row.inputFiles) ||
    arrays.some(
      (value) => !Array.isArray(value) || value.some((entry) => typeof entry !== "string"),
    )
  ) {
    return { supported: false, reason: "Fi has not described this variant's file transport." };
  }
  return row.file !== null ||
    Object.keys(row.inputFiles).length > 0 ||
    arrays.some((value) => (value as string[]).length > 0)
    ? { supported: false, reason: FILE_UNSUPPORTED }
    : { supported: true };
}

function catalog(body: JsonRecord): JsonRecord[] {
  if (
    body.ok !== true ||
    !Array.isArray(body.operations) ||
    !body.operations.every(
      (row): row is JsonRecord =>
        isRecord(row) && typeof row.operation === "string" && typeof row.variant === "string",
    ) ||
    !(body.nextOffset === null || Number.isSafeInteger(body.nextOffset))
  ) {
    throw new Error("Fi returned an invalid operation catalog; no operation was dispatched.");
  }
  return body.operations;
}

async function envelope(response: Response): Promise<JsonRecord | undefined> {
  const body: unknown = await response.json().catch(() => undefined);
  return isRecord(body) ? body : undefined;
}

/** Gateway-owned transport. Fi's registry and dispatcher remain the operation and permission owners. */
export function createAdminOperationTool(
  context: OpenClawPluginToolContext<2>,
  proven: () => Requester | undefined,
): AnyAgentTool {
  return {
    name: "fi_admin_operation",
    label: "Fi administrator operation",
    description:
      "Discover and execute existing Fi operations as this turn's verified requester, without shell commands. Discover lists current server operations; provide operation and variant for their schema and constraints. Execute accepts that operation, variant, structured input and optional dryRun. Fi applies the requester's current permissions and binds their actor identity. Never supply URLs, headers, credentials, tenant overrides, local paths or attachments. File variants need the existing CLI or verified artifact workflow. Preserve warnings and receipts. An unconfirmed or partially completed operation must be reconciled before retry; this tool never retries a write.",
    parameters: schema,
    async execute(_toolCallId, raw, signal) {
      context.assertInvocationCurrent();
      signal?.throwIfAborted();
      if (!Value.Check(schema, raw)) {
        throw new Error("Invalid Fi operation request; no operation was dispatched.");
      }
      const input = raw as Static<typeof schema>;
      if (input.action === "discover" && input.variant && !input.operation) {
        throw new Error("A variant filter requires its operation.");
      }
      // Bound model input before minting or sending anything. JSON is data, never shell code.
      const serialized = input.action === "execute" ? JSON.stringify(input.input) : undefined;
      if (serialized && Buffer.byteLength(serialized) > 128 * 1024) {
        throw new Error("Operation input exceeds 128 KiB; no operation was dispatched.");
      }
      const requester = proven();
      if (!requester) {
        throw new Error(
          "This turn has no current verified Fi-admin requester; no operation was dispatched.",
        );
      }
      const expectedIdentity = identity(requester);
      const assertCurrent = () => {
        context.assertInvocationCurrent();
        signal?.throwIfAborted();
        const current = proven();
        if (!current || identity(current) !== expectedIdentity) {
          throw new Error("The requester or Fi environment changed; no further request was sent.");
        }
      };
      const delegation = await lookupDelegation(requester.connection, requester.body, {
        agentId: FI_ADMIN_DELEGATION_AGENT_ID,
        signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      });
      assertCurrent();
      if (
        !delegation ||
        !JWT.test(delegation.fi?.token ?? "") ||
        !Number.isFinite(delegation.fi?.expiresAt) ||
        delegation.fi.expiresAt * 1000 <= Date.now() ||
        !delegation.user.orgSlug
      ) {
        throw new Error(
          "Fi did not issue a current requester credential; no operation was dispatched.",
        );
      }
      const root = `/api/${encodeURIComponent(delegation.user.orgSlug)}/admin-operations`;
      const query = new URLSearchParams();
      if (input.operation) query.set("operation", input.operation);
      if (input.variant) query.set("variant", input.variant);
      if (input.action === "discover") {
        if (input.limit !== undefined) query.set("limit", String(input.limit));
        if (input.offset !== undefined) query.set("offset", String(input.offset));
      }
      const response = await delegatedFetch(requester.connection, delegation, `${root}?${query}`, {
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
      });
      const body = await envelope(response);
      assertCurrent();
      if (!body)
        throw new Error("Fi operation discovery is unavailable; no operation was dispatched.");
      if (!response.ok || body.ok !== true) {
        return jsonResult({ httpStatus: response.status, response: body, dispatched: false });
      }
      const rows = catalog(body);
      if (input.action === "discover") {
        return jsonResult({
          httpStatus: response.status,
          response: body,
          typedExecution: rows.map((row) => ({
            operation: row.operation,
            variant: row.variant,
            ...filelessSupport(row),
          })),
        });
      }
      const selected = rows.filter(
        (row) => row.operation === input.operation && row.variant === input.variant,
      );
      if (selected.length !== 1 || rows.length !== 1 || body.nextOffset !== null) {
        throw new Error(
          "Fi did not identify exactly one operation variant; no operation was dispatched.",
        );
      }
      const support = filelessSupport(selected[0]!);
      if (!support.supported) throw new Error(support.reason);
      const form = new FormData();
      form.set("input", serialized!);
      if (input.dryRun === true) form.set("dryRun", "true");
      assertCurrent();
      const path = `${root}/${encodeURIComponent(input.operation)}/${encodeURIComponent(input.variant)}`;
      let result: Response;
      let reply: JsonRecord | undefined;
      try {
        result = await delegatedFetch(requester.connection, delegation, path, {
          method: "POST",
          body: form,
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(signal ? [signal] : [])]),
        });
        reply = await envelope(result);
        assertCurrent();
      } catch {
        return jsonResult({
          dispatched: true,
          recovery: {
            outcome: "unconfirmed",
            automaticRetry: false,
            action: "reconcile-before-retry",
          },
        });
      }
      // Never flatten or discard a server receipt, including partial results and output failure.
      const notStarted =
        reply?.execution !== null &&
        typeof reply?.execution === "object" &&
        (reply.execution as JsonRecord).state === "not-started" &&
        reply.completed !== true &&
        !Object.hasOwn(reply, "result") &&
        reply.outputUnconfirmed !== true;
      const confirmed = result.ok && reply?.ok === true && reply.outputUnconfirmed !== true;
      return jsonResult({
        httpStatus: result.status,
        ...(reply ? { response: reply } : {}),
        dispatched: true,
        ...(!confirmed
          ? {
              recovery: {
                outcome: notStarted ? "not-started" : "unconfirmed",
                automaticRetry: false,
                action: notStarted ? "correct-request-before-retry" : "reconcile-before-retry",
              },
            }
          : {}),
      });
    },
  };
}
