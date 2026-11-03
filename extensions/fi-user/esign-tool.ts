import { createHash } from "node:crypto";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { delegatedJson, exchange, pathSegment } from "./fi-delegation.js";

function orgRoot(orgSlug: string) {
  return `/api/${encodeURIComponent(orgSlug)}`;
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
    project: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Project slug; exclusive with company.",
      }),
    ),
    company: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$",
        description:
          "prepare/send_envelope: company id of a company-level document (exclusive with project). A company has no owner signatory: ownerRole/ownerEmail name the signer the document calls for.",
      }),
    ),
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
  project?: string;
  company?: string;
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
      "ownerRole and ownerEmail are required: the project's owner signatory (from action=list or the project's signing view), or for a company document the signer it names",
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
        project: input.project ?? null,
        company: input.company ?? null,
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
      "E-sign through Fi as the verified requester, for project documents they can read on their documents or construction grant, and (prepare/send_envelope with company) company documents they can read on the company's documents grant, where ownerRole/ownerEmail name the signer the document calls for: list envelopes and reviewed templates; status of an envelope; resend the provider's reminder to a signer already on the envelope (once a day); prepare a private signing template from the reviewed preparation manifest (action=prepare; sends nothing); create an envelope from that template with an explicit route (action=send_envelope: owner signatory, any further signers such as an internal admin or a counterparty named in the document, viewers, completion copies) — the first call returns the exact route and a routeCode, show it to the requester verbatim, and call again with confirmRoute only after they approve; delivery is hold unless docuseal is chosen. action=send still sends a reviewed template with its stored defaults (confirmSend=true). Changing a signer on an existing envelope, archiving and filing stay administrator actions (request_admin_action).",
    parameters: EsignSchema,
    async execute(_toolCallId, raw) {
      const input = raw as EsignInput;
      const { delegation, config } = await exchange(api, context);
      const root = orgRoot(delegation.user.orgSlug);
      if (Boolean(input.project) === Boolean(input.company)) {
        throw new Error("Give exactly one of project or company");
      }
      if (input.company && input.action !== "prepare" && input.action !== "send_envelope") {
        throw new Error(
          "A company document supports prepare and send_envelope; list, status, resend and send are per project",
        );
      }
      const base = input.project ? `${root}/${pathSegment(input.project, "project")}/esign` : "";
      // Who owns the document, as Fi's signing verbs name it. A company route always states its signer.
      const owner = (): Record<string, unknown> =>
        input.company
          ? {
              company: input.company,
              primarySigner: {
                role: input.ownerRole?.trim(),
                email: lower(input.ownerEmail ?? ""),
              },
            }
          : { project: input.project, ownerRole: input.ownerRole };
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
        if (
          !input.documentId ||
          !input.ownerRole ||
          !input.manifest ||
          (input.company && !input.ownerEmail)
        ) {
          throw new Error(
            "documentId, ownerRole and manifest (the reviewed preparation manifest) are required to prepare; a company document also needs ownerEmail (its signer)",
          );
        }
        return jsonResult(
          await operation(
            "prepare",
            {
              input: {
                ...owner(),
                document: input.documentId,
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
          ...owner(),
          document: input.documentId,
          template: input.templateId,
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
