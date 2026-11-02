import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  delegatedFetch,
  delegatedJson,
  exchange,
  pathSegment,
  readFiResponse,
} from "./fi-delegation.js";
import { downloadDriveFile, driveFilingExportArgs, requireMailbox } from "./gam.js";
import { generatedFileAction } from "./generated-artifacts.js";
import {
  downloadSlackFile,
  MAX_SLACK_FILE_BYTES,
  resolveRequesterSlackFile,
  slackBotToken,
  slackConversation,
} from "./slack-files.js";

const DIRECT_SLACK_SESSION = /^agent:[^:]+:slack:direct:/i;

function orgRoot(orgSlug: string) {
  return `/api/${encodeURIComponent(orgSlug)}`;
}

// ── fi_user_deliver_file ─────────────────────────────────────────────

const DeliverSchema = Type.Object(
  {
    action: Type.Optional(
      stringEnum(["prepare", "register", "inspect", "deliver", "reconcile"] as const),
    ),
    fileName: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
    artifactId: Type.Optional(Type.String({ pattern: "^ga_[0-9a-f-]{36}$" })),
    documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    project: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: "Project slug of the document." }),
    ),
    driveFileId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
    via: Type.Optional(
      stringEnum(["dm", "link"] as const, {
        description:
          "dm: use only when the requester explicitly asks for a DM. link: an authenticated Fi document link with existing access checks. Generated files default to the current Slack channel/thread; existing documents default to link outside a DM. Never switch a collaborative conversation to DM on your own.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        maxLength: 1_000,
        description:
          "Caption for existing document delivery. Generated artifacts are attached without a caption; describe them in your final reply after the receipt.",
      }),
    ),
  },
  { additionalProperties: false },
);

type DeliverInput = {
  action?: "prepare" | "register" | "inspect" | "deliver" | "reconcile";
  fileName?: string;
  artifactId?: string;
  documentId?: string;
  project?: string;
  driveFileId?: string;
  via?: "dm" | "link";
  message?: string;
};

async function sendSlackDm(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
  requesterSenderId: string,
  filePath: string,
  text: string,
) {
  const adapter = await api.runtime.channel.outbound.loadAdapter("slack");
  if (!adapter?.sendMedia) {
    throw new Error("Slack file delivery is unavailable");
  }
  const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
  return adapter.sendMedia({
    cfg,
    to: `user:${requesterSenderId}`,
    text,
    mediaUrl: filePath,
    mediaLocalRoots: [path.dirname(filePath)],
    mediaReadFile: (candidate: string) => fs.readFile(candidate),
    forceDocument: true,
    ...(context.agentAccountId ? { accountId: context.agentAccountId } : {}),
  });
}

export function createDeliverFileTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "fi_user_deliver_file",
    label: "Send me a file",
    description:
      "Deliver a file in the current conversation. For a new workbook/PDF/CSV: action=prepare returns this session's outputDirectory; generate and validate the file there; action=register with fileName returns artifactId; action=deliver with artifactId attaches it in the current Slack channel/thread and returns a receipt. An existing DM stays in that DM. Use via=dm only after an explicit requester instruction. action=inspect with fileName displays a PNG/JPEG preview generated in that directory. Existing Fi documents use documentId + project and default to an authenticated link outside a DM; own Drive files use driveFileId. via=link requires an existing Fi document. Never silently switch destinations, expose internal paths as downloads, or claim delivery before a successful receipt. Retain artifacts for retry.",
    parameters: DeliverSchema,
    async execute(_toolCallId, raw) {
      const input = raw as DeliverInput;
      if (input.action || input.artifactId) {
        if (input.documentId || input.driveFileId) {
          throw new Error("Generated-artifact actions cannot also select a Fi or Drive document");
        }
        return generatedFileAction(api, context, input);
      }
      const { delegation, config, identity } = await exchange(api, context);
      if (Boolean(input.documentId) === Boolean(input.driveFileId)) {
        throw new Error("Provide exactly one of documentId or driveFileId");
      }
      const inDirect = DIRECT_SLACK_SESSION.test(context.sessionKey ?? "");
      const via = input.via ?? (inDirect ? "dm" : "link");
      if (via === "dm" && identity.channel !== "slack") {
        throw new Error("Direct-message delivery is available on Slack; use via=link here");
      }
      const text = input.message?.trim() || "Here is the file you asked for.";

      if (input.driveFileId) {
        if (via !== "dm" || identity.channel !== "slack") {
          throw new Error("Drive files are delivered by Slack DM; open Drive for a link");
        }
        const mailbox = requireMailbox(delegation, "Google Drive");
        const downloaded = await downloadDriveFile({
          config,
          mailbox,
          fileId: input.driveFileId,
          exportArgs: driveFilingExportArgs,
        });
        try {
          await sendSlackDm(api, context, identity.requesterSenderId, downloaded.filePath, text);
          return jsonResult({ delivered: "slack_dm", file: downloaded.metadata.name });
        } finally {
          await fs.rm(downloaded.tempDir, { recursive: true, force: true });
        }
      }

      const documentId = decodeURIComponent(pathSegment(input.documentId, "documentId"));
      if (via === "link") {
        const shared = (await delegatedJson(
          config,
          delegation,
          `${orgRoot(delegation.user.orgSlug)}/documents/share`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              documentId,
              ...(input.project ? { project: input.project } : {}),
            }),
          },
          "Fi document share",
        )) as { url?: string; libraryUrl?: string; access?: string; document?: unknown };
        return jsonResult({
          delivered: "link",
          url: shared.url,
          libraryUrl: shared.libraryUrl,
          access: shared.access,
          document: shared.document,
        });
      }

      if (identity.channel !== "slack") {
        throw new Error("Direct-message delivery is available on Slack only");
      }
      const project = pathSegment(input.project, "project");
      const response = await delegatedFetch(
        config,
        delegation,
        `${orgRoot(delegation.user.orgSlug)}/${project}/docs/${encodeURIComponent(documentId)}/file?download=1`,
        { method: "GET" },
      );
      if (!response.ok) {
        const detail = await readFiResponse(response);
        throw new Error(
          `Fi document download failed (${response.status}): ${String(detail).slice(0, 300)}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_SLACK_FILE_BYTES) {
        throw new Error("That document is too large to attach; use via=link");
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      const fileName = path
        .basename(decodeURIComponent(named ?? `${documentId}.pdf`))
        .replace(/[^\w.\- ]+/g, "_");
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fi-user-deliver-"));
      try {
        const filePath = path.join(tempDir, fileName || "document");
        await fs.writeFile(filePath, bytes);
        await sendSlackDm(api, context, identity.requesterSenderId, filePath, text);
        return jsonResult({ delivered: "slack_dm", file: fileName, bytes: bytes.byteLength });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

// ── fi_user_esign ────────────────────────────────────────────────────

const Recipient = Type.Object(
  {
    role: Type.String({
      minLength: 1,
      maxLength: 100,
      description: "Template role, exactly as in the manifest.",
    }),
    email: Type.String({ format: "email", maxLength: 320 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const EsignSchema = Type.Object(
  {
    action: stringEnum(["list", "status", "resend", "send", "prepare", "send_envelope"] as const),
    project: Type.String({ minLength: 1, maxLength: 200, description: "Project slug." }),
    submissionId: Type.Optional(Type.Integer({ minimum: 1 })),
    signerEmail: Type.Optional(Type.String({ format: "email" })),
    documentId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    templateId: Type.Optional(Type.Integer({ minimum: 1 })),
    completionCopies: Type.Optional(Type.Array(Type.String({ format: "email" }), { maxItems: 20 })),
    confirmSend: Type.Optional(Type.Boolean()),
    ownerRole: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description: "Template role the project's owner signatory signs as.",
      }),
    ),
    manifest: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "prepare: the reviewed preparation manifest (source hash, page count, confidences, reviewer, evidence, fields).",
      }),
    ),
    dryRun: Type.Optional(
      Type.Boolean({ description: "prepare: resolve and check only; creates nothing." }),
    ),
    ownerEmail: Type.Optional(
      Type.String({
        format: "email",
        description: "send_envelope: the owner signatory's email, as stated to the requester.",
      }),
    ),
    additionalSigners: Type.Optional(Type.Array(Recipient, { maxItems: 10 })),
    viewers: Type.Optional(Type.Array(Recipient, { maxItems: 10 })),
    delivery: Type.Optional(
      stringEnum(["hold", "docuseal"] as const, {
        description:
          "send_envelope: hold (default) creates the envelope and emails nobody; docuseal emails the invitations.",
      }),
    ),
    message: Type.Optional(
      Type.Object(
        {
          subject: Type.String({ minLength: 1, maxLength: 300 }),
          body: Type.String({ minLength: 1, maxLength: 5_000 }),
        },
        { additionalProperties: false },
      ),
    ),
    replyTo: Type.Optional(Type.String({ format: "email" })),
    confirmRoute: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{16}$",
        description: "send_envelope: the routeCode of the preview the requester approved.",
      }),
    ),
  },
  { additionalProperties: false },
);

type EsignRecipient = { role: string; email: string; name?: string };

type EsignInput = {
  action: "list" | "status" | "resend" | "send" | "prepare" | "send_envelope";
  project: string;
  submissionId?: number;
  signerEmail?: string;
  documentId?: string;
  templateId?: number;
  completionCopies?: string[];
  confirmSend?: boolean;
  ownerRole?: string;
  manifest?: Record<string, unknown>;
  dryRun?: boolean;
  ownerEmail?: string;
  additionalSigners?: EsignRecipient[];
  viewers?: EsignRecipient[];
  delivery?: "hold" | "docuseal";
  message?: { subject: string; body: string };
  replyTo?: string;
  confirmRoute?: string;
};

type EsignTemplate = {
  sourceDocumentId: string;
  templateId: number;
  ownerEmail: string;
  additionalSignerRoles: string[];
  sent: boolean;
};

type RouteEntry = { kind: "signer" | "viewer" | "completion"; role?: string; email: string };

const lower = (email: string) => email.trim().toLowerCase();

/**
 * The whole envelope route as stated: the owner signatory, every further
 * signer and viewer, every completion copy. Nothing is added to it here; Fi
 * refuses a send whose resolved route is not exactly this list.
 */
export function statedEsignRoute(input: EsignInput): RouteEntry[] {
  if (!input.ownerRole?.trim() || !input.ownerEmail?.trim()) {
    throw new Error(
      "ownerRole and ownerEmail (the project's owner signatory, from action=list or the project's signing view) are required",
    );
  }
  const completion = [...new Set((input.completionCopies ?? []).map(lower))];
  return [
    { kind: "signer", role: input.ownerRole.trim(), email: lower(input.ownerEmail) },
    ...(input.additionalSigners ?? []).map((entry) => ({
      kind: "signer" as const,
      role: entry.role.trim(),
      email: lower(entry.email),
    })),
    ...(input.viewers ?? []).map((entry) => ({
      kind: "viewer" as const,
      role: entry.role.trim(),
      email: lower(entry.email),
    })),
    ...completion.map((email) => ({ kind: "completion" as const, email })),
  ];
}

/** A short code for one exact route of one template: the approval names the route it approved. */
export function esignRouteCode(input: EsignInput, route: RouteEntry[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        project: input.project,
        documentId: input.documentId,
        templateId: input.templateId,
        delivery: input.delivery ?? "hold",
        route,
        message: input.message ?? null,
        replyTo: input.replyTo ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

const recipientRecord = (kind: "signer" | "viewer", entry: EsignRecipient) =>
  entry.name
    ? { kind, role: entry.role, email: entry.email, name: entry.name }
    : { kind, role: entry.role, email: entry.email };

const routeLine = (entry: RouteEntry) =>
  entry.kind === "completion"
    ? `completion copy: ${entry.email}`
    : `${entry.kind} (${entry.role}): ${entry.email}`;

export function createEsignTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "fi_user_esign",
    label: "E-sign (as you)",
    description:
      "E-sign through Fi as the verified requester, for project documents they can read on their documents or construction grant: list envelopes and reviewed templates; status of an envelope; resend the provider's reminder to a signer already on the envelope (once a day); prepare a private signing template from the reviewed preparation manifest (action=prepare; sends nothing); create an envelope from that template with an explicit route (action=send_envelope: owner signatory, any further signers such as an internal admin or a counterparty named in the document, viewers, completion copies) — the first call returns the exact route and a routeCode, show it to the requester verbatim, and call again with confirmRoute only after they approve; delivery is hold unless docuseal is chosen. action=send still sends a reviewed template with its stored defaults (confirmSend=true). Changing a signer on an existing envelope, archiving and filing stay administrator actions (request_admin_action).",
    parameters: EsignSchema,
    async execute(_toolCallId, raw) {
      const input = raw as EsignInput;
      const { delegation, config } = await exchange(api, context);
      const root = orgRoot(delegation.user.orgSlug);
      const base = `${root}/${pathSegment(input.project, "project")}/esign`;
      const operation = (
        verb: "prepare" | "send",
        body: { input: Record<string, unknown>; dryRun?: boolean },
        label: string,
      ) =>
        delegatedJson(
          config,
          delegation,
          `${root}/signature/${verb}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          label,
        );
      if (input.action === "list") {
        return jsonResult(await delegatedJson(config, delegation, base, {}, "Fi e-sign list"));
      }
      if (input.action === "status" || input.action === "resend") {
        if (!input.submissionId) {
          throw new Error("submissionId is required");
        }
        const pathname = `${base}/submissions/${input.submissionId}`;
        if (input.action === "status") {
          return jsonResult(
            await delegatedJson(config, delegation, pathname, {}, "Fi e-sign status"),
          );
        }
        return jsonResult(
          await delegatedJson(
            config,
            delegation,
            `${pathname}/resend`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input.signerEmail ? { signerEmail: input.signerEmail } : {}),
            },
            "Fi e-sign resend",
          ),
        );
      }
      if (input.action === "prepare") {
        if (!input.documentId || !input.ownerRole || !input.manifest) {
          throw new Error(
            "documentId, ownerRole and manifest (the reviewed preparation manifest) are required to prepare",
          );
        }
        return jsonResult(
          await operation(
            "prepare",
            {
              input: {
                project: input.project,
                document: input.documentId,
                ownerRole: input.ownerRole,
                manifest: input.manifest,
              },
              ...(input.dryRun === true ? { dryRun: true } : {}),
            },
            "Fi e-sign prepare",
          ),
        );
      }
      if (input.action === "send_envelope") {
        if (!input.documentId || !input.templateId) {
          throw new Error(
            "documentId and templateId (from action=prepare or action=list) are required",
          );
        }
        const route = statedEsignRoute(input);
        const routeCode = esignRouteCode(input, route);
        const envelope = (confirmed: boolean) => ({
          project: input.project,
          document: input.documentId,
          template: input.templateId,
          ownerRole: input.ownerRole,
          additionalRecipients: [
            ...(input.additionalSigners ?? []).map((entry) => recipientRecord("signer", entry)),
            ...(input.viewers ?? []).map((entry) => recipientRecord("viewer", entry)),
          ],
          completionBcc: route
            .filter((entry) => entry.kind === "completion")
            .map((entry) => entry.email),
          confirmedRecipients: route,
          delivery: input.delivery ?? "hold",
          ...(input.message ? { message: input.message } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          additionalRecipientsConfirmed: confirmed,
        });
        if (input.confirmRoute !== undefined && input.confirmRoute !== routeCode) {
          throw new Error(
            "This is not the route the requester approved (the recipients, delivery or message changed): preview it again without confirmRoute",
          );
        }
        if (input.confirmRoute === undefined) {
          // Fi resolves the envelope and refuses any route that is not exactly this one; nothing is created.
          const planned = await operation(
            "send",
            { input: envelope(false), dryRun: true },
            "Fi e-sign route check",
          );
          return jsonResult({
            preview: true,
            delivery: input.delivery ?? "hold",
            emailsRecipients: (input.delivery ?? "hold") === "docuseal",
            route: route.map(routeLine),
            routeCode,
            checked: planned,
            next: "Show the requester exactly these recipients and the delivery; call again with the same arguments and confirmRoute=routeCode only after they approve.",
          });
        }
        return jsonResult(await operation("send", { input: envelope(true) }, "Fi e-sign send"));
      }
      if (!input.documentId || !input.templateId) {
        throw new Error("documentId and templateId (from action=list) are required to send");
      }
      const listed = (await delegatedJson(config, delegation, base, {}, "Fi e-sign list")) as {
        templates?: EsignTemplate[];
      };
      const template = listed.templates?.find(
        (candidate) =>
          candidate.sourceDocumentId === input.documentId &&
          candidate.templateId === input.templateId,
      );
      if (!template) {
        throw new Error(
          "That document has no reviewed e-sign template yet: analyze it, build the reviewed manifest and use action=prepare, then action=send_envelope",
        );
      }
      if (template.sent) {
        throw new Error("That reviewed template was already sent; use status or resend");
      }
      if (template.additionalSignerRoles.length > 0) {
        throw new Error(
          `This template needs signers beyond the stored defaults (${template.additionalSignerRoles.join(", ")}); use action=send_envelope with those signers stated`,
        );
      }
      const completionBcc = [
        ...new Set(
          [delegation.user.email, ...(input.completionCopies ?? [])].map((email) =>
            email.toLowerCase(),
          ),
        ),
      ];
      if (input.confirmSend !== true) {
        return jsonResult({
          preview: true,
          signer: template.ownerEmail,
          completionCopies: completionBcc,
          next: "Show this to the requester; call again with confirmSend=true only after they approve.",
        });
      }
      return jsonResult(
        await delegatedJson(
          config,
          delegation,
          `${base}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              documentId: input.documentId,
              templateId: input.templateId,
              recipientsConfirmed: true,
              additionalSignerRecipients: [],
              completionBcc,
            }),
          },
          "Fi e-sign send",
        ),
      );
    },
  };
}

// ── fi_user_budget_import ────────────────────────────────────────────

const BudgetSchema = Type.Object(
  {
    project: Type.String({ minLength: 1, maxLength: 200, description: "Project slug." }),
    mode: Type.Optional(stringEnum(["dry-run", "apply"] as const)),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    changeNote: Type.String({ minLength: 1, maxLength: 2_000 }),
    effectiveFrom: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    baseChangeSetId: Type.Optional(Type.String({ maxLength: 200 })),
    rows: Type.Optional(
      Type.Array(
        Type.Object(
          {
            costCode: Type.String({ minLength: 1, maxLength: 50 }),
            description: Type.String({ maxLength: 500 }),
            amount: Type.Number(),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 2_000 },
      ),
    ),
    slackFileId: Type.Optional(Type.String({ pattern: "^F[A-Za-z0-9]{6,}$" })),
    driveFileId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
    confirmApply: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

type BudgetInput = {
  project: string;
  mode?: "dry-run" | "apply";
  label: string;
  changeNote: string;
  effectiveFrom?: string;
  baseChangeSetId?: string;
  rows?: Array<{ costCode: string; description: string; amount: number }>;
  slackFileId?: string;
  driveFileId?: string;
  confirmApply?: boolean;
};

/** Dry runs this session has shown the requester, by source + target. */
const budgetDryRuns = new Map<string, number>();
const BUDGET_DRY_RUN_TTL_MS = 2 * 60 * 60 * 1000;

export function createBudgetImportTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "fi_user_budget_import",
    label: "Budget revision import (as you)",
    description:
      "Import a budget revision into Fi as the verified requester, for a project where they hold budget write access (admin or construction grant). Always run mode=dry-run first and show the requester the per-cost-code diff; apply only after they confirm (mode=apply, confirmApply=true) with the exact same source. The source is `rows` or a workbook: a Slack file they posted here (slackFileId) or a file in their own Drive (driveFileId).",
    parameters: BudgetSchema,
    async execute(_toolCallId, raw) {
      const input = raw as BudgetInput;
      const { delegation, config, identity } = await exchange(api, context);
      const mode = input.mode ?? "dry-run";
      const sources = [input.rows, input.slackFileId, input.driveFileId].filter(Boolean);
      if (sources.length !== 1) {
        throw new Error("Provide exactly one source: rows, slackFileId or driveFileId");
      }
      const fields: Record<string, string> = {
        label: input.label,
        changeNote: input.changeNote,
        mode,
        ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
        ...(input.baseChangeSetId ? { baseChangeSetId: input.baseChangeSetId } : {}),
      };

      let body: FormData | string;
      let sourceHash: string;
      let cleanup: (() => Promise<void>) | undefined;
      if (input.rows) {
        body = JSON.stringify({ ...fields, rows: input.rows });
        sourceHash = createHash("sha256").update(JSON.stringify(input.rows)).digest("hex");
      } else {
        let bytes: Uint8Array;
        let name: string;
        if (input.slackFileId) {
          const conversation = slackConversation(context);
          const token = slackBotToken(context);
          if (identity.channel !== "slack" || !conversation || !token) {
            throw new Error("slackFileId is available in Slack conversations only");
          }
          const file = await resolveRequesterSlackFile({
            token,
            conversation,
            requesterSenderId: identity.requesterSenderId,
            fileId: input.slackFileId,
          });
          bytes = await downloadSlackFile(token, file);
          name = file.name ?? "budget.xlsx";
        } else {
          const downloaded = await downloadDriveFile({
            config,
            mailbox: requireMailbox(delegation, "Google Drive"),
            fileId: input.driveFileId!,
            exportArgs: driveFilingExportArgs,
          });
          cleanup = () => fs.rm(downloaded.tempDir, { recursive: true, force: true });
          bytes = new Uint8Array(await fs.readFile(downloaded.filePath));
          name = path.basename(downloaded.filePath);
        }
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
          form.set(key, value);
        }
        form.set(
          "file",
          new Blob([
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          ]),
          name,
        );
        body = form;
        sourceHash = createHash("sha256").update(bytes).digest("hex");
      }

      try {
        const key = [
          context.sessionKey,
          delegation.user.email,
          input.project,
          input.baseChangeSetId ?? "",
          sourceHash,
        ].join("|");
        if (mode === "apply") {
          const seen = budgetDryRuns.get(key);
          if (!seen || Date.now() - seen > BUDGET_DRY_RUN_TTL_MS) {
            throw new Error(
              "Run mode=dry-run with this exact source first and show the requester the diff",
            );
          }
          if (input.confirmApply !== true) {
            throw new Error(
              "confirmApply=true is required after the requester explicitly approves the dry-run diff",
            );
          }
        }
        const result = await delegatedJson(
          config,
          delegation,
          `${orgRoot(delegation.user.orgSlug)}/${pathSegment(input.project, "project")}/budget/revisions/import`,
          {
            method: "POST",
            ...(typeof body === "string"
              ? { headers: { "content-type": "application/json" } }
              : {}),
            body,
          },
          "Fi budget revision import",
        );
        if (mode === "dry-run") {
          budgetDryRuns.set(key, Date.now());
        } else {
          budgetDryRuns.delete(key);
        }
        return jsonResult(result);
      } finally {
        await cleanup?.();
      }
    },
  };
}
