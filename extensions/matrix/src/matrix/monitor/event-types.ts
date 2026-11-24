import { isPollEventType } from "../poll-types.js";
import { EventType } from "./types.js";

/** Application events handled by Matrix; protocol events such as receipts are not work. */
export function isMatrixApplicationEventType(eventType: string): boolean {
  return (
    eventType === EventType.RoomMessage ||
    eventType === EventType.Location ||
    eventType === EventType.Reaction ||
    isPollEventType(eventType)
  );
}
