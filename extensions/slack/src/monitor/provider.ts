import type { RequestListener } from "node:http";
import { WebClient } from "@slack/web-api";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "openclaw/plugin-sdk/lazy-runtime";
import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  warn,
  computeBackoff,
  createNonExitingRuntime,
  sleepWithAbort,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount } from "../accounts.js";
import { isSlackAnyNativeApprovalClientEnabled } from "../approval-native-gates.js";
import { registerBoundSourceReplyDelivery } from "../bound-source-reply.js";
import {
  resolveSlackLookupClientOptions,
  resolveSlackMonitorDispatchers,
  resolveSlackWebClientOptions,
} from "../client-options.js";
import { createSlackStartupAuthClient, createSlackWebClient } from "../client.js";
import { formatSlackError } from "../errors.js";
import { normalizeSlackWebhookPath } from "../http/paths.js";
import { registerSlackInstallationState } from "../installation-identity-state.js";
import { resolveSlackMediaMaxBytes } from "../limits.js";
import { getSlackRuntime } from "../runtime.js";
import { setSlackDefaultSendIdentity } from "../send.js";
import { registerSlackThreadOwnerPeer } from "../sent-thread-cache.js";
import { resolveSlackAppToken, resolveSlackBotToken } from "../token.js";
import { registerSlackApprovalRuntimeContext } from "./approval-runtime-context.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { resolveSlackSlashCommandConfig } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import { createSlackMonitorContext } from "./context.js";
import {
  resolveSlackIdentityHealth,
  resolveSlackInstallationIdentity,
  type SlackInstallationIdentity,
} from "./enterprise-install.js";
import { registerSlackCommonEvents, registerSlackWorkspaceEvents } from "./events.js";
import { createSlackHttpRequestHandler, registerSlackHttpHandler } from "./http-handler.js";
import { createSlackDurableIngress } from "./ingress.js";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  buildSlackLivenessKey,
  openSlackSocketLivenessStore,
  SLACK_LIVENESS_HEARTBEAT_MS,
} from "./missed-mentions.js";
import { openSlackPresenceCooldownStore } from "./presence-cooldown-store.js";
import {
  createSlackPresenceMonitor,
  hasSlackPresenceEventsEnabled,
  SLACK_PRESENCE_REQUEST_TIMEOUT_MS,
} from "./presence-monitor.js";
import { createSlackProjectionReader } from "./projection-reader.js";
import { resolveSlackSocketAppId } from "./provider-identity.js";
import { resolveSlackBootIdentity, createSlackInstallationPolicy } from "./provider-identity.js";
import {
  applySlackInstallationIdentity,
  adoptSlackIdentity,
  resolveSlackRelayConfig,
} from "./provider-identity.js";
import { createSlackReconnectRecovery } from "./provider-recovery.js";
import { createSlackStatusEventTracker } from "./provider-status.js";
import {
  createSlackBoltApp,
  gracefulStopSlackApp,
  publishSlackConnectedStatus,
  trackSlackAuthFailure,
  publishSlackDisconnectedStatus,
  resolveSlackBoltInterop,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import {
  createSlackWorkspaceClientResolver,
  withSlackPresenceLifecycleSignal,
} from "./provider-workspace-client.js";
import {
  formatSlackSocketModeSharedConnectionWarning,
  registerSlackSocketModeConnectionDiagnostics,
  SLACK_SOCKET_RECONNECT_POLICY,
} from "./reconnect-policy.js";
import { prewarmSlackRuntimeContext, resolveSlackMonitorPolicy } from "./runtime-policy.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";
import type { MonitorSlackOpts } from "./types.js";

const getSlackBoltInterop = createLazyRuntimeSurface(
  () => import("@slack/bolt"),
  resolveSlackBoltInterop,
);

const loadSlackRelaySource = createLazyRuntimeModule(() => import("./relay-source.js"));

export async function monitorSlackProvider(opts: MonitorSlackOpts) {
  const { scheduler } = opts;
  const cfg = opts.config ?? (await captureRuntimeConfigAsyncReader()());
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.enabled) {
    runtime.log?.(`[${account.accountId}] slack account disabled; monitor startup skipped`);
    await waitUntilAbort(opts.abortSignal);
    return;
  }

  const slackMode = opts.mode ?? account.config.mode ?? "socket";
  const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
  const signingSecret =
    slackMode === "http"
      ? normalizeResolvedSecretInputString({
          value: account.config.signingSecret,
          path: `channels.slack.accounts.${account.accountId}.signingSecret`,
        })
      : undefined;
  const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
  const userToken = account.userToken;
  const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
  const relayConfig =
    slackMode === "relay"
      ? resolveSlackRelayConfig({
          relay: account.config.relay,
          accountId: account.accountId,
        })
      : undefined;
  let token: string;
  if (account.identity === "user") {
    if (!userToken) {
      throw new Error(
        `Slack user token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.userToken or SLACK_USER_TOKEN for default).`,
      );
    }
    if (slackMode === "socket" && !appToken) {
      throw new Error(
        `Slack app token missing for user-identity socket mode account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.appToken or SLACK_APP_TOKEN for default).`,
      );
    }
    if (slackMode === "http" && !signingSecret) {
      throw new Error(
        `Slack signing secret missing for user-identity HTTP mode account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`,
      );
    }
    token = userToken;
  } else {
    if (!botToken || (slackMode === "socket" && !appToken)) {
      const missing =
        slackMode === "socket"
          ? `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`
          : `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).`;
      throw new Error(missing);
    }
    if (slackMode === "http" && !signingSecret) {
      throw new Error(
        `Slack signing secret missing for account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`,
      );
    }
    token = botToken;
  }

  const slackCfg = account.config;
  const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
  const mediaMaxBytes = resolveSlackMediaMaxBytes(opts.mediaMaxMb ?? slackCfg.mediaMaxMb);
  const slackDispatchers = resolveSlackMonitorDispatchers(slackMode);
  const clientOptions = resolveSlackWebClientOptions({}, slackDispatchers.webApi);
  const durableIngress = createSlackDurableIngress({
    accountId: account.accountId,
    ...(runtime.log ? { onLog: runtime.log } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
  const monitorContextRef: { current?: SlackMonitorContext } = {};
  let slackLivenessTimer: ReturnType<typeof setInterval> | undefined;
  let slackRecoveryAbort: AbortController | undefined;
  // Socket Mode drops what happens while disconnected. Projection readers use
  // this to re-snapshot DMs after a reconnect instead of waiting for rotation.
  let socketConnectedAt: number | undefined;
  const { app, receiver, socketClient, socketModeLogger } = createSlackBoltApp({
    interop: await getSlackBoltInterop(),
    slackMode,
    token,
    appToken: slackMode === "socket" ? (appToken ?? undefined) : undefined,
    signingSecret: signingSecret ?? undefined,
    slackWebhookPath,
    clientOptions: clientOptions as Record<string, unknown>,
    dispatcher: slackDispatchers.socketMode,
    wrapReceiver: durableIngress.wrapReceiver,
    onContextIdentity: async (identity) => {
      const current = monitorContextRef.current;
      if (!current) {
        return;
      }
      const recovered =
        current.identityHealth.lifecycle === "blocked" ? await recoverSlackIdentity() : false;
      const contextTeamId = normalizeOptionalString(identity.teamId);
      const contextEnterpriseId = normalizeOptionalString(identity.enterpriseId);
      const contextInstallationIdentity =
        identity.isEnterpriseInstall === false && contextTeamId
          ? ({
              kind: "workspace",
              teamId: contextTeamId,
              ...(contextEnterpriseId ? { enterpriseId: contextEnterpriseId } : {}),
            } satisfies SlackInstallationIdentity)
          : undefined;
      const adopted =
        current.identityHealth.lifecycle === "blocked" &&
        contextInstallationIdentity !== undefined &&
        adoptSlackIdentity({
          ctx: current,
          identity: account.identity,
          installationIdentity: contextInstallationIdentity,
          botUserId: identity.botUserId,
          botId: identity.botId,
        });
      if (adopted && contextInstallationIdentity) {
        installationState.update(
          contextInstallationIdentity.kind,
          contextInstallationIdentity.teamId,
        );
        await installSlackRuntimeForIdentity(contextInstallationIdentity);
      }
      if (
        !current.apiAppId &&
        identity.apiAppId &&
        current.installationIdentity.kind !== "degraded"
      ) {
        // HTTP accounts have no app token and auth.test omits app_id for bot tokens,
        // so the first signed event is the earliest trusted source. Recorded once;
        // later mismatches are dropped by shouldDropMismatchedSlackEvent, never re-learned.
        applySlackInstallationIdentity(current, {
          ...current.installationIdentity,
          apiAppId: identity.apiAppId,
        });
        runtime.log?.(
          `[${account.accountId}] slack app id ${identity.apiAppId} learned from signed event`,
        );
      }
      if (recovered || adopted) {
        publishSlackConnectedStatus(opts.setStatus, current.identityHealth);
      }
    },
  });

  const slackHttpHandler =
    slackMode === "http" && receiver
      ? createSlackHttpRequestHandler({
          receiver: receiver as { requestListener: RequestListener },
          accountId: account.accountId,
        })
      : null;
  let unregisterHttpHandler: (() => void) | null = null;
  const unregisterSocketModeConnectionDiagnostics = socketClient
    ? registerSlackSocketModeConnectionDiagnostics({
        client: socketClient,
        onSharedConnection: (activeConnections) => {
          runtime.log?.(warn(formatSlackSocketModeSharedConnectionWarning(activeConnections)));
        },
      })
    : () => {};

  const expectedApiAppIdFromAppToken = resolveSlackSocketAppId(slackMode, appToken);
  const { botUserId, botId, authTestError, authIdentityWarning, authTestIdentity } =
    await resolveSlackBootIdentity({ token, clientOptions, account });
  const assertSlackInstallationPolicy = createSlackInstallationPolicy({ account, cfg, slackMode });
  const installationIdentity = resolveSlackInstallationIdentity({
    auth: authTestError === undefined ? authTestIdentity : undefined,
    transportApiAppId: expectedApiAppIdFromAppToken,
  });
  assertSlackInstallationPolicy(installationIdentity);
  const teamId = installationIdentity.kind === "workspace" ? installationIdentity.teamId : "";
  const apiAppId =
    installationIdentity.kind === "degraded" ? "" : (installationIdentity.apiAppId ?? "");
  if (authTestError !== undefined) {
    const identityFailureDetail =
      account.identity === "user"
        ? "explicit self-mention detection will be disabled while the user identity is unresolved"
        : "explicit bot-mention detection will be disabled while the bot identity is unresolved";
    runtime.log?.(
      warn(
        `[${account.accountId}] slack auth.test failed at boot (${authTestError}); ` +
          `${identityFailureDetail}; ` +
          "required-mention channels will ignore messages without another trusted activation signal",
      ),
    );
  }
  if (authIdentityWarning) {
    runtime.log?.(warn(authIdentityWarning));
  }

  const identityHealth = resolveSlackIdentityHealth({
    installationIdentity,
    botUserId,
    authTestError,
    authIdentityWarning,
  });

  if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) {
    const identityTokenLabel = account.identity === "user" ? "user token" : "bot token";
    runtime.error?.(
      `slack token mismatch: ${identityTokenLabel} app_id=${apiAppId} but app token looks like app_id=${expectedApiAppIdFromAppToken}`,
    );
  }

  const ctx = createSlackMonitorContext({
    abortSignal: opts.abortSignal,
    cfg,
    accountId: account.accountId,
    botToken: token,
    lookupToken: account.userToken || botToken,
    app,
    runtime,
    channelRuntime: opts.channelRuntime,
    botUserId,
    botId,
    identityHealth,
    teamId,
    apiAppId,
    installationIdentity,
    ...resolveSlackMonitorPolicy(cfg, account.accountId, runtime),
    slashCommand,
    mediaMaxBytes,
  });
  monitorContextRef.current = ctx;

  // Slack's socket-mode client keeps ping/pong health private and closes on
  // missed pongs. App events are useful status activity, but not transport proof.
  const trackEvent = createSlackStatusEventTracker(opts.setStatus);

  const presenceEventsEnabled = hasSlackPresenceEventsEnabled({
    account: slackCfg.presenceEvents,
    channels: slackCfg.channels,
  });
  let presenceRequestAbort: AbortController | undefined;
  let presenceMonitor: ReturnType<typeof createSlackPresenceMonitor> | undefined;
  let runtimeStarted = false;
  const installSlackPresenceRuntime = (identity: SlackInstallationIdentity) => {
    if (
      !presenceEventsEnabled ||
      presenceMonitor ||
      identity.kind === "degraded" ||
      opts.abortSignal?.aborted
    ) {
      return;
    }
    presenceRequestAbort = new AbortController();
    const options = resolveSlackLookupClientOptions(
      { ...clientOptions, timeout: SLACK_PRESENCE_REQUEST_TIMEOUT_MS },
      slackDispatchers.webApi,
    );
    options.fetch = withSlackPresenceLifecycleSignal(
      options.fetch ?? globalThis.fetch,
      presenceRequestAbort.signal,
    );
    const resolveClient = createSlackWorkspaceClientResolver({
      appClient: new WebClient(token, options),
      token,
      clientOptions: options,
      installationIdentity: identity,
    });
    presenceMonitor = createSlackPresenceMonitor({
      scheduler,
      system: getSlackRuntime().system,
      accountId: account.accountId,
      accountConfig: slackCfg.presenceEvents,
      resolveClient: (workspaceTeamId) => resolveClient(workspaceTeamId).users,
      cooldownStore: openSlackPresenceCooldownStore(),
      log: runtime.log,
      error: runtime.error,
    });
    if (runtimeStarted) {
      presenceMonitor.start();
    }
  };
  const handleSlackMessage = createSlackMessageHandler({
    ctx,
    abortSignal: opts.abortSignal,
    trackEvent,
    onPrepared: (prepared) => presenceMonitor?.observe(prepared),
  });
  registerSlackCommonEvents({
    ctx,
    handleSlackMessage,
    trackEvent,
  });
  const commandRegistration = await registerSlackMonitorSlashCommands({ ctx, account, trackEvent });
  const appHomeSlashCommandName =
    commandRegistration.mode === "single" ? commandRegistration.name : undefined;

  let workspaceRuntimePromise: Promise<void> | undefined;
  const installSlackWorkspaceRuntime = async () => {
    workspaceRuntimePromise ??= (async () => {
      registerSlackWorkspaceEvents({
        ctx,
        appHomeSlashCommandName,
        trackEvent,
      });
      void prewarmSlackRuntimeContext(ctx);
      if (runtimeStarted) {
        presenceMonitor?.start();
      }
    })();
    return await workspaceRuntimePromise;
  };

  let approvalRuntimeInstalled = false;
  function installSlackApprovalRuntime(identity: SlackInstallationIdentity) {
    if (
      approvalRuntimeInstalled ||
      identity.kind === "degraded" ||
      !isSlackAnyNativeApprovalClientEnabled({ cfg, accountId: account.accountId })
    ) {
      return;
    }
    const resolveClient = createSlackWorkspaceClientResolver({
      appClient: app.client,
      token,
      clientOptions,
      installationIdentity: identity,
    });
    registerSlackApprovalRuntimeContext({
      app,
      config: slackCfg.execApprovals ?? {},
      resolveClient,
      identity,
      channelRuntime: opts.channelRuntime,
      accountId: account.accountId,
      abortSignal: opts.abortSignal,
    });
    approvalRuntimeInstalled = true;
  }

  async function installSlackRuntimeForIdentity(identity: SlackInstallationIdentity) {
    if (identity.kind === "workspace") {
      const readClient = createSlackWebClient(account.userToken || token, {
        ...clientOptions,
        timeout: 10_000,
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
      });
      registerChannelRuntimeContext({
        channelRuntime: opts.channelRuntime,
        channelId: "slack",
        accountId: account.accountId,
        capability: "thread-read-projection",
        context: createSlackProjectionReader({
          client: readClient,
          writeClient: createSlackWebClient(token, clientOptions),
          workspaceId: identity.teamId,
          botUserId: ctx.botUserId,
          socketConnectedAt: () => socketConnectedAt,
        }),
        abortSignal: opts.abortSignal,
      });
      registerBoundSourceReplyDelivery({
        channelRuntime: opts.channelRuntime,
        accountId: account.accountId,
        cfg,
        abortSignal: opts.abortSignal,
      });
    }
    installSlackApprovalRuntime(identity);
    installSlackPresenceRuntime(identity);
    if (identity.kind === "workspace") {
      await installSlackWorkspaceRuntime();
    }
  }

  let identityRecoveryPromise: Promise<boolean> | undefined;
  async function recoverSlackIdentity() {
    if (ctx.identityHealth.lifecycle !== "blocked") {
      return false;
    }
    if (identityRecoveryPromise) {
      return await identityRecoveryPromise;
    }
    const recovery = (async () => {
      try {
        const auth = await createSlackStartupAuthClient(token, clientOptions).auth.test();
        const recoveredInstallationIdentity = resolveSlackInstallationIdentity({
          auth,
          transportApiAppId: expectedApiAppIdFromAppToken,
        });
        assertSlackInstallationPolicy(recoveredInstallationIdentity);
        const adopted = adoptSlackIdentity({
          ctx,
          identity: account.identity,
          installationIdentity: recoveredInstallationIdentity,
          botUserId: auth.user_id,
          botId: (auth as { bot_id?: string }).bot_id,
        });
        if (!adopted) {
          return false;
        }
        installationState.update(
          recoveredInstallationIdentity.kind,
          recoveredInstallationIdentity.kind === "workspace"
            ? recoveredInstallationIdentity.teamId
            : undefined,
        );
        await installSlackRuntimeForIdentity(recoveredInstallationIdentity);
        return true;
      } catch (err) {
        ctx.identityHealth = {
          lifecycle: "blocked",
          lastError: formatSlackError(err),
        };
        return false;
      }
    })();
    identityRecoveryPromise = recovery;
    try {
      return await recovery;
    } finally {
      if (identityRecoveryPromise === recovery) {
        identityRecoveryPromise = undefined;
      }
    }
  }

  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted && slackMode === "socket") {
      void gracefulStopSlackApp(app, socketClient);
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
  const installationState = registerSlackInstallationState(
    account.accountId,
    installationIdentity.kind,
    installationIdentity.kind === "workspace" ? installationIdentity.teamId : undefined,
  );
  const unregisterThreadOwnerPeer = registerSlackThreadOwnerPeer(account.accountId, {
    botUserId: () => ctx.botUserId,
    answersUnmentioned: (channelId, channelName) => {
      const channelConfig = resolveSlackChannelConfig({
        teamId: ctx.teamId,
        allowUnscoped: ctx.installationIdentity?.kind !== "enterprise",
        channelId,
        channelName,
        channels: ctx.channelsConfig,
        channelKeys: ctx.channelsConfigKeys,
        defaultRequireMention: ctx.defaultRequireMention,
        allowNameMatching: ctx.allowNameMatching,
      });
      return Boolean(channelConfig?.allowed && !channelConfig.requireMention);
    },
  });

  try {
    await installSlackRuntimeForIdentity(installationIdentity);
    durableIngress.start();
    runtimeStarted = true;
    presenceMonitor?.start();
    if (slackMode === "http" && slackHttpHandler) {
      unregisterHttpHandler = registerSlackHttpHandler({
        path: slackWebhookPath,
        handler: slackHttpHandler,
        log: runtime.log,
        accountId: account.accountId,
      });
      publishSlackConnectedStatus(opts.setStatus, ctx.identityHealth);
    }

    if (socketClient) {
      let reconnectAttempts = 0;
      let disconnectedAt: number | undefined;
      const authState = { consecutiveInvalidAuth: 0 };
      const logError = (message: string) => runtime.error?.(message);
      let hasLoggedSocketConnected = false;
      // Socket Mode drops everything that happens while we are disconnected, so
      // the socket records that it is alive and each reconnect replays what it
      // missed between the last mark and now.
      const livenessStore = openSlackSocketLivenessStore();
      // Resolved per use: the workspace id is only final once identity recovery
      // has run, which happens inside onStarted.
      const livenessKey = () =>
        buildSlackLivenessKey({ accountId: account.accountId, teamId: ctx.teamId });
      // Recovery is owned by this monitor, not an individual socket attempt.
      // One pending window coalesces reconnects while the current sweep settles.
      slackRecoveryAbort = new AbortController();
      const recoverySignal = opts.abortSignal
        ? AbortSignal.any([opts.abortSignal, slackRecoveryAbort.signal])
        : slackRecoveryAbort.signal;
      const requestRecovery = createSlackReconnectRecovery({
        ctx,
        accountId: account.accountId,
        client: app.client,
        runtime,
        recoverySignal,
        handleSlackMessage,
      });
      let activeSocket: { live: boolean; stopped: boolean } | undefined;
      const markAlive = async () => {
        if (!activeSocket?.live || opts.abortSignal?.aborted) {
          return;
        }
        try {
          await livenessStore?.register(livenessKey(), Date.now());
        } catch (error) {
          runtime.log?.(`slack socket liveness mark failed: ${formatSlackError(error)}`);
        }
      };
      if (livenessStore) {
        slackLivenessTimer = setInterval(() => void markAlive(), SLACK_LIVENESS_HEARTBEAT_MS);
        slackLivenessTimer.unref?.();
      }
      while (!opts.abortSignal?.aborted) {
        let delayMs: number;
        const attempt = { live: false, stopped: false };
        activeSocket = attempt;
        try {
          const disconnect = await startSlackSocketAndWaitForDisconnect({
            app,
            socketClient,
            abortSignal: opts.abortSignal,
            onDisconnected: () => {
              attempt.live = false;
              attempt.stopped = true;
            },
            onStarted: async () => {
              // A started socket ends the failure episode even when the SDK reports
              // its disconnect before start() settles; only live-socket work is gated.
              reconnectAttempts = 0;
              disconnectedAt = undefined;
              authState.consecutiveInvalidAuth = 0;
              if (attempt.stopped || opts.abortSignal?.aborted) {
                return;
              }
              socketConnectedAt = Date.now();
              await recoverSlackIdentity();
              if (attempt.stopped || opts.abortSignal?.aborted) {
                return;
              }
              if (livenessStore) {
                // Read the previous mark before overwriting it, or the gap we
                // are about to measure is always zero.
                const lastAliveAt = await livenessStore
                  .lookup(livenessKey())
                  .catch(() => undefined);
                // Read the old mark before admitting connected heartbeats.
                if (attempt.stopped || opts.abortSignal?.aborted) {
                  return;
                }
                attempt.live = true;
                await markAlive();
                if (attempt.stopped || opts.abortSignal?.aborted) {
                  return;
                }
                // Recovery must not hold up the socket it just came back on.
                requestRecovery(lastAliveAt);
              }
              publishSlackConnectedStatus(opts.setStatus, ctx.identityHealth);
              if (!hasLoggedSocketConnected) {
                hasLoggedSocketConnected = true;
                runtime.log?.(
                  ctx.identityHealth.lifecycle === "blocked"
                    ? "slack socket mode connected (degraded identity)"
                    : "slack socket mode connected",
                );
              }
            },
          });
          attempt.live = false;
          attempt.stopped = true;
          if (!disconnect) {
            break;
          }
          if (opts.abortSignal?.aborted) {
            break;
          }
          publishSlackDisconnectedStatus(
            opts.setStatus,
            disconnect.error,
            (disconnectedAt ??= Date.now()),
          );

          trackSlackAuthFailure(
            disconnect.error,
            "auth: disconnected, skipping channel",
            opts.setStatus,
            logError,
            authState,
          );

          reconnectAttempts += 1;
          delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
          if (runtime.log) {
            const suffix = disconnect.error ? ` (${formatSlackError(disconnect.error)})` : "";
            runtime.log(
              warn(
                `slack socket disconnected (${disconnect.event}); reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts}/∞)${suffix}`,
              ),
            );
          }
          await gracefulStopSlackApp(app, socketClient);
        } catch (err) {
          attempt.live = false;
          attempt.stopped = true;
          trackSlackAuthFailure(
            err,
            "auth: start failed, skipping channel",
            opts.setStatus,
            logError,
            authState,
          );
          publishSlackDisconnectedStatus(opts.setStatus, err, (disconnectedAt ??= Date.now()));
          reconnectAttempts += 1;
          delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
          if (runtime.error) {
            const lastSdkMessage = socketModeLogger.getLastMessage();
            const reason = formatSlackError(
              err,
              "Slack Socket Mode start failed without error detail",
            );
            const sdkContext = lastSdkMessage?.trim()
              ? `; last SDK log: ${lastSdkMessage.trim()}`
              : "";
            runtime.error(
              `slack socket mode failed to start; retry ${reconnectAttempts}/∞ in ${Math.round(delayMs / 1000)}s reason="${reason}${sdkContext}"`,
            );
          }
        }
        try {
          await sleepWithAbort(delayMs, opts.abortSignal);
        } catch {
          break;
        }
      }
    } else if (slackMode === "relay" && relayConfig) {
      const relaySource = await loadSlackRelaySource();
      runtime.log?.(
        `slack relay mode connecting to ${relayConfig.url} gateway_id:${relayConfig.gatewayId}`,
      );
      // Keep relay identity on the account default so claimed events retain it after restart.
      durableIngress.attachRelayDispatch(async (message, turnAdoptionLifecycle) => {
        await handleSlackMessage(relaySource.requireSlackMessageEvent(message), {
          source: "message",
          wasMentioned: true,
          awaitDispatch: true,
          turnAdoptionLifecycle,
        });
      });
      await relaySource.monitorSlackRelaySource({
        config: relayConfig,
        acceptRelayEvent: durableIngress.acceptRelayEvent,
        runtime,
        abortSignal: opts.abortSignal,
        identityHealth: ctx.identityHealth,
        setStatus: opts.setStatus,
        setIdentity: (identity) => setSlackDefaultSendIdentity(account.accountId, identity),
      });
    } else {
      runtime.log?.(`slack http mode listening at ${slackWebhookPath}`);
      await waitUntilAbort(opts.abortSignal);
    }
  } finally {
    ctx.closeRuntimeContext();
    slackRecoveryAbort?.abort();
    if (slackLivenessTimer) {
      clearInterval(slackLivenessTimer);
    }
    unregisterThreadOwnerPeer();
    installationState.release();
    runtimeStarted = false;
    presenceRequestAbort?.abort();
    await presenceMonitor?.stop();
    if (slackMode === "relay") {
      setSlackDefaultSendIdentity(account.accountId, undefined);
    }
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    unregisterSocketModeConnectionDiagnostics();
    unregisterHttpHandler?.();
    await durableIngress.stop();
    await gracefulStopSlackApp(app, socketClient);
    await slackDispatchers.close();
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
