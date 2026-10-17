import type { CoreConfig } from "../types.js";
import { withResolvedMatrixSendClient } from "./send/client.js";

/** Read through the selected native account; malformed or unavailable proof throws. */
export async function isJoinedMatrixMember(params: {
  cfg: CoreConfig;
  accountId: string;
  expectedAccountUserId: string;
  groupId: string;
  userId: string;
  assertCurrent: () => void;
}): Promise<boolean> {
  params.assertCurrent();
  return withResolvedMatrixSendClient(
    {
      cfg: params.cfg,
      accountId: params.accountId,
      assertDirectAdapterHandoff: params.assertCurrent,
    },
    async (client) => {
      // A cached getUserId() does not prove which principal owns this token.
      const identity: unknown = await client.doRequest("GET", "/_matrix/client/v3/account/whoami");
      params.assertCurrent();
      if (
        !identity ||
        typeof identity !== "object" ||
        !("user_id" in identity) ||
        identity.user_id !== params.expectedAccountUserId
      ) {
        throw new Error("Native Matrix account identity does not match");
      }
      const members = await client.getJoinedRoomMembers(params.groupId);
      params.assertCurrent();
      if (!Array.isArray(members) || members.some((member) => typeof member !== "string")) {
        throw new Error("Native Matrix membership proof is unavailable");
      }
      if (!members.includes(params.expectedAccountUserId)) {
        throw new Error("Native Matrix account is not joined");
      }
      return members.includes(params.userId);
    },
  );
}
