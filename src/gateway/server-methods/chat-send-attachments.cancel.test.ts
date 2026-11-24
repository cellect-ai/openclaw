import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import * as mediaStore from "../../media/store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById } from "../chat-abort.js";
import * as attachments from "../chat-attachments.js";
import {
  attachmentConfig,
  attachmentParams,
  createUpload,
} from "./chat-send-attachments.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

// Originals are offloaded before ACK. Workspace staging is exercised by the native
// owner/workspace/backend suites, never by resurrecting the retired pre-ACK stage.
test.for([
  { kind: "signal-abort", pdf: false },
  { kind: "signal-abort", pdf: true },
  { kind: "signal-ordinary", pdf: false },
  { kind: "rpc-ordinary", pdf: false },
  { kind: "late-rpc-ordinary", pdf: false },
  { kind: "undefined-ordinary", pdf: false },
] as const)(
  "preserves native offload cleanup and failure precedence: $kind PDF=$pdf",
  async ({ kind, pdf }, { signal: testSignal }) => {
    await withOpenClawTestState({ label: "native-upload-failure" }, async (state) => {
      await loadOrCreateProcessDeviceIdentityAsync();
      const cfg = attachmentConfig(state);
      const runId = "offload-failure";
      const content = pdf ? "%PDF-1.4\n% synthetic\n%%EOF\n" : "small original upload";
      const extension = pdf ? "pdf" : "txt";
      const params = attachmentParams(runId, `first.${extension}`, content);
      params.attachments.push(
        ...attachmentParams(runId, `second.${extension}`, content).attachments,
      );
      let inboundPath: string | undefined;
      const presentAtResponse: boolean[] = [];
      const respond = vi.fn<RespondFn>(() =>
        presentAtResponse.push(Boolean(inboundPath && existsSync(inboundPath))),
      );
      const upload = await createUpload(state, cfg, params, respond);
      const { admission, context } = upload;
      const signal = admission.activeRunAbort.controller.signal;
      const reason = createAgentRunDirectAbortError();
      const ordinaryFailure = new Error("native storage write unavailable");
      const saveEntered = createDeferred();
      const saveRelease = createDeferred();
      const cleanupEntered = createDeferred();
      const cleanupRelease = createDeferred();
      const save = mediaStore.saveMediaBuffer;
      const remove = mediaStore.deleteMediaBuffer;
      let saves = 0;
      const saveSpy = vi
        .spyOn(mediaStore, "saveMediaBuffer")
        .mockImplementation(async (...args) => {
          if (++saves === 2) {
            saveEntered.resolve();
            await saveRelease.promise;
            throw kind === "signal-abort"
              ? reason
              : kind === "undefined-ordinary"
                ? undefined
                : ordinaryFailure;
          }
          const result = await save(...args);
          inboundPath = result.path;
          return result;
        });
      const removeSpy = vi
        .spyOn(mediaStore, "deleteMediaBuffer")
        .mockImplementation(async (...args) => {
          cleanupEntered.resolve();
          await cleanupRelease.promise;
          return remove(...args);
        });
      const failureSpy = vi.spyOn(attachments, "logAttachmentFailure");
      const preparing = upload.prepare();
      const abortRpc = () =>
        abortChatRunById(createChatAbortOps(context), {
          runId,
          sessionKey: upload.session.sessionKey,
          stopReason: "rpc",
        });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            saveEntered.promise,
            preparing,
            "second native upload save was not reached",
          ),
          testSignal,
        );
        assert(inboundPath, "first real upload must exist before the failing save");
        expect(existsSync(inboundPath)).toBe(true);
        expect(await fs.readFile(inboundPath, "utf8")).toBe(content);
        if (kind === "rpc-ordinary") expect(abortRpc()).toEqual({ aborted: true });
        else if (kind.startsWith("signal")) admission.activeRunAbort.controller.abort(reason);
        saveRelease.resolve();
        await withinTest(
          awaitGateBeforeSettlement(
            cleanupEntered.promise,
            preparing,
            "parser-owned deletion did not retain custody",
          ),
          testSignal,
        );
        expect(admission.gatewayWorkAdmission.isActive()).toBe(true);
        expect(respond).not.toHaveBeenCalled();
        expect(existsSync(inboundPath)).toBe(true);
        if (kind === "late-rpc-ordinary") {
          // The concrete failure has already happened; a later cancel must not replace it.
          expect.soft(abortRpc()).toEqual({ aborted: false });
          expect.soft(signal.aborted).toBe(false);
        }
        cleanupRelease.resolve();
        expect(await preparing).toEqual({ ok: false });
        expect(existsSync(inboundPath)).toBe(false);
        expect(admission.gatewayWorkAdmission.isActive()).toBe(false);
        expect(presentAtResponse).toEqual([false]);
        expect(respond).toHaveBeenCalledOnce();
        if (kind === "signal-abort" || kind === "rpc-ordinary") {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ runId, summary: "aborted" }),
            undefined,
            { runId },
          );
          expect(failureSpy).not.toHaveBeenCalled();
        } else {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "UNAVAILABLE",
              message: expect.stringContaining(
                kind === "undefined-ordinary" ? "undefined" : ordinaryFailure.message,
              ),
            }),
          );
          const failure = failureSpy.mock.calls[0]?.[2];
          expect(failure).toBeInstanceOf(attachments.MediaOffloadError);
          assert(failure instanceof attachments.MediaOffloadError);
          expect(failure.cause).toBe(kind === "undefined-ordinary" ? undefined : ordinaryFailure);
        }
      } finally {
        saveRelease.resolve();
        cleanupRelease.resolve();
        await Promise.allSettled([preparing]);
        saveSpy.mockRestore();
        removeSpy.mockRestore();
        failureSpy.mockRestore();
        await upload.cleanup();
      }
    });
  },
);
