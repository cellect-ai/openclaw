import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import { resolveMatrixAuth } from "./matrix/client.js";
import {
  isJoinedMatrixMember,
  listJoinedMatrixMembers,
} from "./matrix/conversation-participant.js";
import { cleanupMatrixDeliveryPlans, reconcileMatrixUnknownSend } from "./matrix/delivery-plan.js";
import { probeMatrix } from "./matrix/probe.js";
import { sendMessageMatrix, sendTypingMatrix } from "./matrix/send.js";
import { matrixOutbound } from "./outbound.js";
import { resolveMatrixTargets } from "./resolve-targets.js";

export const matrixChannelRuntime = {
  isJoinedMatrixMember,
  listJoinedMatrixMembers,
  cleanupMatrixDeliveryPlans,
  listMatrixDirectoryGroupsLive,
  listMatrixDirectoryPeersLive,
  matrixOutbound,
  probeMatrix,
  resolveMatrixAuth,
  resolveMatrixTargets,
  reconcileMatrixUnknownSend,
  sendMessageMatrix,
  sendTypingMatrix,
};
