import assert from "node:assert/strict";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as attachments from "../chat-attachments.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import type { RespondFn } from "./types.js";

type Preparation = Parameters<typeof prepareChatSendAttachments>[0];
type Entry = Partial<NonNullable<Preparation["session"]["entry"]>>;
type AttachmentOptions = {
  params: ReturnType<typeof attachmentParams>;
  session: Pick<Preparation["session"], "cfg"> &
    Omit<Partial<Preparation["session"]>, "entry"> & { entry?: Entry };
  admission?: { initialSessionEntry?: Entry; admittedSessionEntry?: Entry };
  abortCleanup?: () => void;
  context?: Partial<Preparation["context"]>;
};

export function attachmentConfig(
  state: OpenClawTestState,
  {
    mode = "all",
    sandboxRoot = "sandboxes",
    mediaMaxMb,
    global = false,
  }: { mode?: "off" | "all"; sandboxRoot?: string; mediaMaxMb?: number; global?: boolean } = {},
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: global
        ? { main: { workspace: state.path("main") }, work: { workspace: state.path("work") } }
        : { main: { workspace: state.workspaceDir } },
      defaults: {
        skipBootstrap: true,
        ...(mediaMaxMb === undefined ? {} : { mediaMaxMb }),
        sandbox: {
          mode,
          scope: "agent",
          workspaceRoot: state.path(sandboxRoot),
          workspaceAccess: "none",
        },
      },
    },
    ...(global ? { session: { scope: "global" } } : {}),
  };
}

export function attachmentParams(
  idempotencyKey: string,
  fileName: string,
  content: string | Buffer,
  overrides: { agentId?: string; sessionKey?: string; message?: string } = {},
) {
  return {
    sessionKey: "agent:main:main",
    message: "read the file",
    idempotencyKey,
    attachments: [
      {
        fileName,
        mimeType: fileName.endsWith(".pdf") ? "application/pdf" : "text/plain",
        content: (typeof content === "string" ? Buffer.from(content) : content).toString("base64"),
      },
    ],
    ...overrides,
  };
}

export async function prepareAttachmentFixture(options: AttachmentOptions) {
  const { params, session, admission, abortCleanup } = options;
  const { context = { logGateway: createSubsystemLogger("test/media-owner") } } = options;
  const request = await normalizeChatSendRequest({ client: null, params });
  if (!request.ok) {
    throw new Error(request.error);
  }
  const controller = new AbortController();
  const respond = vi.fn();
  const result = await prepareChatSendAttachments({
    request: request.value,
    session: {
      sessionKey: params.sessionKey,
      agentId: params.agentId ?? "main",
      clientRunId: params.idempotencyKey,
      resolvedSessionModel: { provider: "fixture", model: "fixture" },
      ...session,
    },
    admission: {
      activeRunAbort: { controller, ...(abortCleanup ? { cleanup: abortCleanup } : {}) },
      assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
      cleanupAdmittedRun() {},
      ...admission,
    },
    context,
    respond,
  } as unknown as Preparation);
  return { result, respond };
}

export async function createUpload(
  state: OpenClawTestState,
  cfg: OpenClawConfig,
  params: ReturnType<typeof attachmentParams>,
  respond = vi.fn<RespondFn>(),
) {
  await state.writeConfig(cfg);
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  const setup = await prepareAndAdmitChatSend({ client: null, context, respond, params });
  assert(setup, "chat admission failed");
  const { admission } = setup;
  let prepared: Awaited<ReturnType<typeof prepareChatSendAttachments>> | undefined;
  return {
    ...setup,
    context,
    respond,
    get prepared() {
      return prepared;
    },
    prepare: () =>
      prepareChatSendAttachments({ ...setup, respond, context }).then((result) => {
        prepared = result;
        return result;
      }),
    async cleanup() {
      admission.cleanupAdmittedRun();
      clearAgentRunContext(params.idempotencyKey, admission.lifecycleGeneration);
      if (prepared?.ok) {
        await attachments.discardPreparedInboundMedia(prepared.value.offloadedRefs);
      }
    },
  };
}
