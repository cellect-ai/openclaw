import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  mergeSlackAccountConfig,
  resolveSlackAccount,
  resolveSlackOperationToken,
  type ResolvedSlackAccount,
} from "./accounts.js";

/** Keep durable replies on the identity and credential that admitted the turn. */
export function prepareSlackFinalDeliveryConfig(
  cfg: OpenClawConfig,
  admitted: Pick<ResolvedSlackAccount, "accountId" | "identity">,
  admittedToken: string,
): OpenClawConfig {
  const token = admittedToken.trim();
  const account = resolveSlackAccount({ cfg, accountId: admitted.accountId });
  if (
    !token ||
    !account.enabled ||
    account.accountId !== normalizeAccountId(admitted.accountId) ||
    account.identity !== admitted.identity ||
    resolveSlackOperationToken(account, "write") !== token
  ) {
    const message = "The Slack reply sender changed during this turn; delivery was not started.";
    throw new PlatformMessageNotDispatchedError(message, {
      cause: new Error(message),
      retryable: false,
    });
  }
  const slack = cfg.channels?.slack;
  const accounts = slack?.accounts;
  const key =
    accounts && Object.hasOwn(accounts, account.accountId)
      ? account.accountId
      : (Object.keys(accounts ?? {}).find(
          (candidate) => normalizeAccountId(candidate) === account.accountId,
        ) ?? account.accountId);
  // Pin environment-resolved credentials before async preparation can change the sender.
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      slack: {
        ...slack,
        accounts: {
          ...accounts,
          [key]: {
            ...mergeSlackAccountConfig(cfg, account.accountId),
            ...(account.identity === "user" ? { userToken: token } : { botToken: token }),
          },
        },
      },
    },
  };
}
