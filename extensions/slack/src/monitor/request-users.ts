// Slack channel request-user policy keeps admitted collaborators context-only.
import { resolveSlackUserAllowed } from "./allow-list.js";

export function resolveSlackRequestUserAllowed(params: {
  requestUsers?: Array<string | number>;
  teamId?: string;
  userId?: string;
}): boolean {
  if (params.requestUsers === undefined) {
    return true;
  }
  if (params.requestUsers.length === 0) {
    return false;
  }
  return resolveSlackUserAllowed({
    allowList: params.requestUsers,
    teamId: params.teamId,
    userId: params.userId,
    allowNameMatching: false,
  });
}
