/** Thrown when an incognito chat.send lifetime was released and then used again. */
export const CHAT_SESSION_STORAGE_ADMISSION_ENDED_MESSAGE = "Chat session storage admission ended";

export function isChatSessionStorageAdmissionEnded(error: unknown): boolean {
  return error instanceof Error && error.message === CHAT_SESSION_STORAGE_ADMISSION_ENDED_MESSAGE;
}
