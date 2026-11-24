import { resolveChannelAccount } from "../../channels/account-resolution.js";
import { getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelAccountBindings } from "../../routing/bindings.js";

const FI_USER_AGENT_ID = "cellect-fi-user";

export type FiUserMatrixRoom =
  | {
      ok: true;
      accountId: string;
      accountUserId: string;
      members: readonly string[];
    }
  | { ok: false; reason: "unavailable" | "unjoined" };

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Joined members of a room, read by the Matrix account bound to cellect-fi-user.
 * The account's own client is the proof. A missing plugin or account is
 * unavailable. A read that throws, or a room this account is not in, is unjoined.
 */
export async function readFiUserMatrixRoom(params: {
  cfg: OpenClawConfig;
  roomId: string;
  assertCurrent: () => void;
}): Promise<FiUserMatrixRoom> {
  params.assertCurrent();
  const plugin = getLoadedChannelPlugin("matrix");
  const listJoinedMembers = plugin?.groups?.listJoinedMembers;
  const accountIds = buildChannelAccountBindings(params.cfg).get("matrix")?.get(FI_USER_AGENT_ID);
  if (!plugin || !listJoinedMembers || !accountIds?.length) {
    return { ok: false, reason: "unavailable" };
  }
  let attempted = false;
  let joined: Extract<FiUserMatrixRoom, { ok: true }> | undefined;
  for (const accountId of accountIds) {
    params.assertCurrent();
    let accountUserId: string | undefined;
    try {
      const account = (await resolveChannelAccount({
        plugin,
        cfg: params.cfg,
        accountId,
      })) as { userId?: unknown };
      accountUserId = typeof account.userId === "string" ? account.userId : undefined;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      continue;
    }
    if (!accountUserId) {
      continue;
    }
    attempted = true;
    try {
      const members = await listJoinedMembers({
        cfg: params.cfg,
        accountId,
        expectedAccountUserId: accountUserId,
        groupId: params.roomId,
        assertCurrent: params.assertCurrent,
      });
      if (joined) {
        return { ok: false, reason: "unavailable" };
      }
      joined = { ok: true, accountId, accountUserId, members };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
    }
  }
  if (joined) {
    return joined;
  }
  return { ok: false, reason: attempted ? "unjoined" : "unavailable" };
}
