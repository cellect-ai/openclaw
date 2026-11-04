import type { AdminActionRecord } from "./admin-action.js";
import { delegatedFetch, type Delegation, type ResolvedPluginConfig } from "./fi-delegation.js";

export type PreparedWiringRequest = {
  companyId: string;
  companyName: string;
  recipientEmail: string;
};
export type WiringReceipt = PreparedWiringRequest & {
  instructionVersionId: string;
  url: string;
  expiresAt: string;
};

/** A request uses the member's company grant, never administrator bank access. */
export async function prepareWiringRequest(
  config: ResolvedPluginConfig,
  delegation: Delegation,
  record: AdminActionRecord,
  assertCurrent: () => void,
): Promise<PreparedWiringRequest> {
  const companyId = record.fields.companyId?.trim();
  const recipientEmail = record.fields.recipientEmail?.trim().toLowerCase();
  if (
    !record.origin ||
    !companyId ||
    !recipientEmail ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)
  ) {
    throw new Error(
      "A wiring request needs an exact company, recipient email and originating Fi conversation.",
    );
  }
  const path = `/${encodeURIComponent(delegation.user.orgSlug)}/companies/${encodeURIComponent(companyId)}`;
  assertCurrent();
  const response = await delegatedFetch(
    config,
    delegation,
    `/api/${encodeURIComponent(delegation.user.orgSlug)}/fi-view/context?path=${encodeURIComponent(path)}`,
  );
  if (!response.ok) {
    throw new Error("The requested company is unavailable under your current grants.");
  }
  const packet = (await response.json()) as {
    resource?: { kind?: string; id?: string; name?: string; synthetic?: boolean };
  };
  assertCurrent();
  const resource = packet.resource;
  if (
    resource?.kind !== "company" ||
    resource.id !== companyId ||
    resource.synthetic ||
    !resource.name?.trim()
  ) {
    throw new Error("Resolve one real company before requesting its receiving wire instructions.");
  }
  const prepared = { companyId, companyName: resource.name, recipientEmail };
  if (wiringSummary(prepared).length > 280) {
    throw new Error("The exact company and recipient do not fit the approval card.");
  }
  return prepared;
}

export function wiringSummary(input: PreparedWiringRequest): string {
  return `Release ${input.companyName}'s verified receiving wire instructions to ${input.recipientEmail}. The recipient must verify their email; no payment or email is sent.`;
}

async function operation(
  config: ResolvedPluginConfig,
  delegation: Delegation,
  verb: "show" | "share",
  input: Record<string, string>,
  assertCurrent: () => void,
) {
  const body = new FormData();
  body.set("input", JSON.stringify(input));
  assertCurrent();
  const response = await delegatedFetch(
    config,
    delegation,
    `/api/${encodeURIComponent(delegation.user.orgSlug)}/admin-operations/book.payment-instruction.${verb}/default`,
    { method: "POST", body, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) {
    throw new Error(
      "The receiving instruction could not be released under the approver's current permissions.",
    );
  }
  const envelope = (await response.json()) as { ok?: boolean; result?: unknown };
  assertCurrent();
  if (envelope.ok !== true) {
    throw new Error("The receiving instruction operation has no verified result.");
  }
  return envelope.result;
}

/** The durable decision is claimed before this call; uncertain writes are never replayed. */
export async function executeApprovedWiringRequest(
  config: ResolvedPluginConfig,
  delegation: Delegation,
  input: PreparedWiringRequest,
  operationId: string,
  assertCurrent: () => void,
): Promise<NonNullable<AdminActionRecord["execution"]>> {
  const unknown = {
    state: "unknown" as const,
    operationId,
    message:
      "Approval recorded; the wire-link outcome is unconfirmed. Reconcile the existing share before making another request.",
  };
  try {
    const owner = (await operation(
      config,
      delegation,
      "show",
      {
        actor: delegation.user.email,
        ownerKind: "company",
        ownerId: input.companyId,
      },
      assertCurrent,
    )) as {
      ownerKind?: string;
      ownerId?: string;
      defaults?: Array<{
        purpose?: string;
        instructionId?: string;
        verificationStatus?: string;
        effectiveTo?: string | null;
      }>;
    };
    const current = owner.defaults?.filter(
      (x) =>
        x.purpose === "investment_funding" &&
        x.verificationStatus === "verified" &&
        !x.effectiveTo &&
        x.instructionId,
    );
    if (
      owner.ownerKind !== "company" ||
      owner.ownerId !== input.companyId ||
      current?.length !== 1
    ) {
      return {
        state: "not_executed",
        operationId,
        message:
          "Approved, but the company has no current verified receiving instruction. No link was created.",
      };
    }
    const expectedInstructionId = current[0]!.instructionId!;
    const result = (await operation(
      config,
      delegation,
      "share",
      {
        actor: delegation.user.email,
        companyId: input.companyId,
        recipientEmail: input.recipientEmail,
        expectedInstructionId,
      },
      assertCurrent,
    )) as {
      applied?: boolean;
      companyId?: string;
      recipientEmail?: string;
      instruction?: { instructionVersionId?: string };
      url?: string;
      expiresAt?: string;
    };
    const url = result.url && new URL(result.url);
    if (
      result.applied !== true ||
      result.companyId !== input.companyId ||
      result.recipientEmail !== input.recipientEmail ||
      result.instruction?.instructionVersionId !== expectedInstructionId ||
      !url ||
      url.origin !== new URL(config.baseUrl).origin ||
      url.username ||
      url.password ||
      !result.expiresAt ||
      !Number.isFinite(Date.parse(result.expiresAt))
    ) {
      return unknown;
    }
    return {
      state: "done",
      operationId,
      message: `Created a recipient-verified wire link for ${input.recipientEmail}. No email or payment was sent.`,
      wiringReceipt: {
        ...input,
        instructionVersionId: expectedInstructionId,
        url: url.href,
        expiresAt: result.expiresAt,
      },
    };
  } catch {
    return unknown;
  }
}
