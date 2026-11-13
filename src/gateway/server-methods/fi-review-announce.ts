import { createHash } from "node:crypto";
import { resolvePersonalReviewDelivery } from "../../../extensions/fi-user/api.js";
import {
  ErrorCodes,
  errorShape,
  validateFiReviewAnnounceParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../config/config.js";
import { isPersonalReviewHookSessionKey } from "../../infra/hook-requester-attestation.js";
import { deliverFiPrivateMain } from "./fi-shadow-announce.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const fiReviewAnnounceHandlers: GatewayRequestHandlers = {
  "fi.review.announce": defineValidatedGatewayMethod(
    "fi.review.announce",
    validateFiReviewAnnounceParams,
    async ({ params, respond, signal }) => {
      if (
        !isPersonalReviewHookSessionKey(params.childSessionKey) ||
        !/^pra:[A-Za-z0-9_-]{1,100}:[A-Za-z0-9_-]{43}$/.test(params.reviewAttestation)
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "review_delivery_forbidden"),
        );
        return;
      }
      try {
        const current = () => resolvePersonalReviewDelivery(getRuntimeConfig(), params, signal);
        const owner = await current();
        const beforeDelivery = async () => {
          const latest = await current();
          if (
            latest.ownerEmail !== owner.ownerEmail ||
            latest.roomId !== owner.roomId ||
            latest.jobId !== owner.jobId
          ) {
            throw new Error("review_destination_changed");
          }
        };
        // The native delivery owner supplies restart-safe direct idempotency; separate replay namespace from mail.
        const key = `review:${createHash("sha256").update(owner.jobId).digest("hex")}`;
        await deliverFiPrivateMain(
          {
            roomId: owner.roomId,
            ownerEmail: owner.ownerEmail,
            childSessionKey: params.childSessionKey,
            idempotencyKey: key,
            label: params.label,
            resultText: params.resultText,
            replyInstruction: "ask_owner",
          },
          owner.ownerEmail,
          respond,
          signal,
          beforeDelivery,
        );
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "review_delivery_unavailable"),
        );
      }
    },
  ),
};
