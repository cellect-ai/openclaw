import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "openclaw/plugin-sdk/lazy-runtime";
import { parseSlackBlocksInput } from "./blocks-input.js";

export const loadSlackActionsRuntime = createLazyRuntimeModule(() => import("./actions.js"));

export const bindSlackAction = createLazyRuntimeMethodBinder(loadSlackActionsRuntime);

export const loadSlackChannelTypeRuntime = createLazyRuntimeModule(
  () => import("./channel-type.js"),
);

export const bindSlackChannelType = createLazyRuntimeMethodBinder(loadSlackChannelTypeRuntime);

export type SlackConversationAccessModule = typeof import("./conversation-access.js");

export const loadSlackConversationAccessRuntime = createLazyRuntimeModule(
  () => import("./conversation-access.js"),
);

export const slackActionRuntime = {
  createSlackChannel: bindSlackAction((runtime) => runtime.createSlackChannel),
  deleteSlackMessage: bindSlackAction((runtime) => runtime.deleteSlackMessage),
  downloadSlackFile: bindSlackAction((runtime) => runtime.downloadSlackFile),
  editSlackMessage: bindSlackAction((runtime) => runtime.editSlackMessage),
  editSlackRenderedMessage: bindSlackAction((runtime) => runtime.editSlackRenderedMessage),
  getSlackMemberInfo: bindSlackAction((runtime) => runtime.getSlackMemberInfo),
  isSlackConversationMember: async (
    ...args: Parameters<SlackConversationAccessModule["isSlackConversationMember"]>
  ) => (await loadSlackConversationAccessRuntime()).isSlackConversationMember(...args),
  listSlackFileShareChannelIds: async (
    ...args: Parameters<SlackConversationAccessModule["listSlackFileShareChannelIds"]>
  ) => (await loadSlackConversationAccessRuntime()).listSlackFileShareChannelIds(...args),
  listSlackEmojis: bindSlackAction((runtime) => runtime.listSlackEmojis),
  listSlackPins: bindSlackAction((runtime) => runtime.listSlackPins),
  listSlackReactions: bindSlackAction((runtime) => runtime.listSlackReactions),
  openSlackConversation: bindSlackAction((runtime) => runtime.openSlackConversation),
  parseSlackBlocksInput,
  pinSlackMessage: bindSlackAction((runtime) => runtime.pinSlackMessage),
  reactSlackMessage: bindSlackAction((runtime) => runtime.reactSlackMessage),
  readSlackMessages: bindSlackAction((runtime) => runtime.readSlackMessages),
  removeOwnSlackReactions: bindSlackAction((runtime) => runtime.removeOwnSlackReactions),
  removeSlackReaction: bindSlackAction((runtime) => runtime.removeSlackReaction),
  resolveSlackConversationInfo: bindSlackChannelType(
    (runtime) => runtime.resolveSlackConversationInfo,
  ),
  sendSlackMessage: bindSlackAction((runtime) => runtime.sendSlackMessage),
  unpinSlackMessage: bindSlackAction((runtime) => runtime.unpinSlackMessage),
};
