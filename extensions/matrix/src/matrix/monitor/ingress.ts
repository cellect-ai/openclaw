import { createStandardRawEventIngressMonitor } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type {
  ChannelIngressMonitorLifecycle,
  ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixRawEvent } from "../sdk.js";
import { isMatrixApplicationEventType } from "./event-types.js";

type MatrixIngressEvent = { roomId: string; event: MatrixRawEvent };
type MatrixIngressPayload = { version: 1; rawEvent: string };
export type MatrixIngressLifecycle = ChannelIngressMonitorLifecycle;

function decode(rawEvent: string): MatrixIngressEvent {
  const raw: unknown = JSON.parse(rawEvent);
  if (!isRecord(raw) || typeof raw.roomId !== "string" || !isRecord(raw.event)) {
    throw new Error("Invalid Matrix durable ingress envelope");
  }
  const event = raw.event;
  if (
    typeof event.event_id !== "string" ||
    !event.event_id.trim() ||
    typeof event.sender !== "string" ||
    typeof event.type !== "string" ||
    typeof event.origin_server_ts !== "number" ||
    !isRecord(event.content)
  ) {
    throw new Error("Invalid Matrix durable ingress event");
  }
  // The channel-owned wire envelope is validated here; optional SDK fields remain
  // unchanged so sender, timestamps, relations, and redaction evidence survive replay.
  return { roomId: raw.roomId, event: event as MatrixRawEvent };
}

export function createMatrixIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<MatrixIngressPayload>;
  dispatch: (
    roomId: string,
    event: MatrixRawEvent,
    lifecycle?: MatrixIngressLifecycle,
  ) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  return createStandardRawEventIngressMonitor({
    queue:
      options.queue ??
      (() =>
        getMatrixRuntime().state.openChannelIngressQueue<MatrixIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (raw: MatrixIngressEvent) =>
      isMatrixApplicationEventType(raw.event.type)
        ? {
            eventId: JSON.stringify([raw.roomId, raw.event.event_id]),
            laneKey: raw.roomId,
          }
        : null,
    payload: {
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (rawEvent) => decode(rawEvent),
      createClaimError: () => new Error("Invalid Matrix durable ingress claim"),
    },
    deliver: (raw, lifecycle) => options.dispatch(raw.roomId, raw.event, lifecycle),
    onError: options.onError,
    classifyAdmissionError: () => undefined,
  });
}
