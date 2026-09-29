import type { CoreConfig } from "../types.js";
import { resolveConfiguredMatrixBotUserIds } from "./accounts.js";
import type { MatrixClient } from "./sdk.js";

/**
 * Whether any human can read a projection room: a joined member that is not a
 * gateway bot and holds no explicit power level. Every service identity in a
 * projection room (provisioner admin, bridge service, projection writers) is
 * granted explicit power; source readers never are. A room nobody can read
 * (a retired conversation, a hidden bot-only observation) gains nothing from a
 * full-snapshot refresh. An unreadable roster counts as readable, so a Matrix
 * error never suppresses a refresh.
 */
export async function projectionRoomHasHumanMember(params: {
  cfg: CoreConfig;
  accountId: string;
  client: Pick<MatrixClient, "getJoinedRoomMembers" | "getRoomStateEvent" | "getUserId">;
  roomId: string;
}): Promise<boolean> {
  try {
    const [members, powerLevels, self] = await Promise.all([
      params.client.getJoinedRoomMembers(params.roomId),
      params.client.getRoomStateEvent(params.roomId, "m.room.power_levels", ""),
      params.client.getUserId(),
    ]);
    const bots = await resolveConfiguredMatrixBotUserIds({
      cfg: params.cfg,
      accountId: params.accountId,
    });
    bots.add(self);
    const users = powerLevels.users;
    const elevated =
      users && typeof users === "object" ? new Set(Object.keys(users)) : new Set<string>();
    return members.some((member) => !bots.has(member) && !elevated.has(member));
  } catch {
    return true;
  }
}

/**
 * Plan field for a room the plan would change (any action other than
 * `unchanged`): whether a refresh can matter to anyone. Omitted otherwise.
 */
export async function humanMemberVerdict(
  actions: ReadonlyArray<{ kind: string }>,
  params: Parameters<typeof projectionRoomHasHumanMember>[0],
): Promise<{ hasHumanMember?: boolean }> {
  return actions.every((action) => action.kind === "unchanged")
    ? {}
    : { hasHumanMember: await projectionRoomHasHumanMember(params) };
}
