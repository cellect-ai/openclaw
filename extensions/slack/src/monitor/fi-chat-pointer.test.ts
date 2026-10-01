import { describe, expect, it } from "vitest";
import {
  FI_CHAT_POINTER_EVENT,
  fiChatPointerText,
  isFiConversationChatUrl,
  isSlackFiChatPointer,
} from "./fi-chat-pointer.js";

const URL =
  "https://app.cellect.ai/fi/shape/chat?fiConversation=8934026f-8d33-43a9-8bde-32bb4cfcbd3c";

describe("Fi chat pointer notices", () => {
  it("matches metadata or a bot message that carries the Fi conversation URL", () => {
    expect(isSlackFiChatPointer({ metadata: { event_type: FI_CHAT_POINTER_EVENT } })).toBe(true);
    expect(
      isSlackFiChatPointer({
        bot_id: "B1",
        text: `This conversation continues in Fi: <${URL}|Open in Fi>`,
      }),
    ).toBe(true);
    expect(isSlackFiChatPointer({ bot: true, text: URL })).toBe(true);
  });

  it("keeps a person pasting the same link in the Slack thread", () => {
    expect(isSlackFiChatPointer({ text: `see ${URL}` })).toBe(false);
    expect(isSlackFiChatPointer({ bot_id: "B1", text: "ordinary bot reply" })).toBe(false);
  });

  it("builds only https Fi conversation links", () => {
    expect(fiChatPointerText(URL)).toBe(`This conversation continues in Fi: <${URL}|Open in Fi>`);
    expect(fiChatPointerText("http://app.cellect.ai/fi/shape/chat?fiConversation=abc")).toBeNull();
    expect(isFiConversationChatUrl(URL)).toBe(true);
    expect(isFiConversationChatUrl("https://evil.test/chat?fiConversation=nope")).toBe(false);
  });
});
