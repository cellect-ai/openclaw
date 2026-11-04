import { compareChannelAdmissionParticipants } from "../../../channels/message-access/admission-evidence.js";
import type { FollowupRun } from "./types.js";

export function resolveCollectedRun(items: readonly FollowupRun[], source: FollowupRun["run"]) {
  const participantComparison = compareChannelAdmissionParticipants(
    items.map((item) => item.channelAdmissionEvidence),
  );
  if (
    participantComparison === "same" ||
    !items.every(
      (item) => compareChannelAdmissionParticipants([item.channelAdmissionEvidence]) === "same",
    )
  ) {
    return source;
  }
  // Mixed or unverifiable people share no downstream sender authority. The
  // opaque admission aggregate records unknown identity at the run boundary.
  return {
    ...source,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderE164: undefined,
    senderIsOwner: false,
    traceAuthorized: false,
    ownerNumbers: [],
  };
}

export function requiresIndividualCollectDrain(item: FollowupRun): boolean {
  return (
    // A definitive native rejection can return an already-committed source.
    // Keep its original recorder/event; only unconsumed sources may regroup.
    item.userTurnTranscriptRecorder?.hasPersisted() === true ||
    item.disableCollectBatching === true ||
    item.run.skillWorkshopProposalRevision !== undefined ||
    item.run.skillLibraryAuthoring !== undefined ||
    item.run.skillWorkshopWorkspaceAuthoring !== undefined ||
    item.currentInboundEventKind === "room_event" ||
    item.currentInboundAudio === true
  );
}
