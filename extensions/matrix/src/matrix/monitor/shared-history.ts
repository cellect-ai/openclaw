import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { isPollStartType } from "../poll-types.js";
import { resolveMatrixThreadRootId } from "../relations.js";
import type { MatrixClient, MatrixRawEvent } from "../sdk.js";
import {
  summarizeMatrixMessageContextEvent,
  truncateMatrixContextBody,
} from "./context-summary.js";

export const DEFAULT_MATRIX_HISTORY_LIMIT = 20;
// One anchored page, not a scan of the room. Busy rooms can have fewer matching thread items.
const MAX_CONTEXT_EVENTS = 100;

export async function readMatrixSharedHistory(params: {
  client: MatrixClient;
  roomId: string;
  event: MatrixRawEvent;
  threadRootId?: string;
  limit: number;
  includeSender: (senderId: string) => boolean;
  logVerboseMessage: (message: string) => void;
}): Promise<HistoryEntry[] | undefined> {
  if (params.limit <= 0 || !params.event.event_id) {
    return undefined;
  }
  let responseReceived = false;
  try {
    // Use the receiving account's authenticated transport. The homeserver owns membership
    // and history_visibility; another agent's credentials/session never supply history.
    // The SDK's private getEventContext hardcodes limit=0; hydrateEvents owns decryption.
    const page = (await params.client.doRequest(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(params.roomId)}/context/${encodeURIComponent(params.event.event_id)}`,
      { limit: Math.min(MAX_CONTEXT_EVENTS, params.limit * 2) },
    )) as { event?: MatrixRawEvent; events_before?: MatrixRawEvent[] };
    responseReceived = true;
    if (
      !page ||
      typeof page !== "object" ||
      page.event?.event_id !== params.event.event_id ||
      (page.event.room_id && page.event.room_id !== params.roomId) ||
      !Array.isArray(page.events_before)
    ) {
      return [];
    }
    // /context returns events_before in reverse-chronological timeline order. Ignore
    // events_after entirely, including on a replay whose timestamp is older than now.
    const events = await params.client.hydrateEvents(
      params.roomId,
      page.events_before
        .slice(0, MAX_CONTEXT_EVENTS)
        .filter(
          (event) =>
            event.event_id !== params.event.event_id &&
            (!event.room_id || event.room_id === params.roomId) &&
            Number.isFinite(event.origin_server_ts) &&
            event.origin_server_ts <= params.event.origin_server_ts,
        ),
    );
    const seen = new Set<string>();
    const history: HistoryEntry[] = [];
    for (const event of events) {
      if (
        (event.room_id && event.room_id !== params.roomId) ||
        event.origin_server_ts > params.event.origin_server_ts ||
        (event.type !== "m.room.message" && !isPollStartType(event.type)) ||
        event.state_key !== undefined ||
        event.unsigned?.redacted_because ||
        !event.event_id ||
        seen.has(event.event_id) ||
        !event.sender ||
        !params.includeSender(event.sender) ||
        resolveMatrixThreadRootId(event.content) !== params.threadRootId ||
        (event.content["m.relates_to"] &&
          (event.content["m.relates_to"] as { rel_type?: unknown }).rel_type === "m.replace")
      ) {
        continue;
      }
      const body = summarizeMatrixMessageContextEvent(event);
      if (!body) {
        continue;
      }
      seen.add(event.event_id);
      history.push({
        sender: event.sender,
        body: truncateMatrixContextBody(body),
        timestamp: event.origin_server_ts,
        messageId: event.event_id,
      });
      if (history.length >= params.limit) {
        break;
      }
    }
    return history.reverse();
  } catch (error) {
    params.logVerboseMessage(
      `matrix: shared history unavailable room=${params.roomId}: ${String(error)}`,
    );
    // Our authenticated transport exposes statusCode; SDK decryption errors can
    // carry MatrixError.httpStatus/errcode. A denial is not a transient cache miss:
    // never resurrect pending content after the account loses access.
    const failure = error as {
      statusCode?: unknown;
      httpStatus?: unknown;
      errcode?: unknown;
    } | null;
    if (
      [401, 403, 404].some(
        (status) => failure?.statusCode === status || failure?.httpStatus === status,
      ) ||
      ["M_FORBIDDEN", "M_NOT_FOUND", "M_UNKNOWN_TOKEN", "M_MISSING_TOKEN"].some(
        (code) => failure?.errcode === code,
      )
    ) {
      return [];
    }
    // A received-but-malformed/decryption-failed page is not a network outage.
    return responseReceived ? [] : undefined;
  }
}
