import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import { adminActionSessions } from "./admin-action.js";
import { adminCommandPosture, namesAnotherFi, runsInSandbox } from "./admin-command-sandbox.js";
import { createAdminDelegationDiagnostic } from "./admin-delegation.diagnostics.js";
import {
  HOOK_BUDGET_MS,
  MAX_MINT_MS,
  MIN_MINT_MS,
  MIN_REMAINING_SECONDS,
  MAX_TRACKED,
  MAX_HOLD_MS,
  heldCopy,
  UNPROVEN_HOLD,
  SANDBOX_TOOLS,
  JWT,
  type Custody,
  type Held,
  tokenSubject,
  remember,
  type Run,
  matrixOriginRequester,
  matrixOriginTurn,
  continuationCurrent,
} from "./admin-delegation.shared.js";
import {
  configFromRuntime,
  delegationTurnFor,
  isAdminAgent,
  FI_ADMIN_DELEGATION_AGENT_ID,
  lookupDelegation,
  matrixConnection,
  mailWakeConnection,
  withHookFiRoute,
  type ResolvedPluginConfig,
} from "./fi-delegation.js";
import { mailWakeDelegationContext } from "./mail-wake-context.js";
import type { MatrixEntitlements } from "./matrix-entitlements.js";
import {
  mailWakeRequester,
  ON_BEHALF_OF_TOOLS,
  onBehalfOfRequester,
  pinInstalledFiCliCommand,
  type CommandDelegation,
} from "./on-behalf-of.js";
import {
  operationCommandArgs,
  operationCommandFailure,
  requestOperationCommandReceipt,
} from "./operation-command.js";
import type { RequesterProofReader } from "./requester-proof.js";

export function createAdminDelegationMint(
  api: OpenClawPluginApi,
  deps: {
    admittedVoiceTurn: MatrixEntitlements["admittedVoiceTurn"];
    admittedOperatorCommand: MatrixEntitlements["admittedOperatorCommand"];
    runs: Map<string, Run>;
    custody: Map<string, Custody>;
    posture: (agentId: string) => ReturnType<typeof adminCommandPosture>;
    sandboxKey: (agentId: string, sessionKey: string) => string;
    diagnose: ReturnType<typeof createAdminDelegationDiagnostic>["diagnose"];
  },
) {
  const {
    admittedVoiceTurn,
    admittedOperatorCommand,
    runs,
    custody,
    posture,
    sandboxKey,
    diagnose,
  } = deps;
  /**
   * Why this tool call may not reach the sandbox now, or nothing. While a
   * token issued into a sandbox has unclosed execution custody, only runs proven to be its owner's
   * may use the tools that reach that sandbox: anyone else's run, and a run
   * nobody proved (cron, heartbeat, an approved action), waits it out.
   */
  const held = (
    config: ResolvedPluginConfig,
    toolName: string,
    ctx: PluginHookToolContext,
    /** The subject of a token Fi has just minted for this call (crossChannelCustody only). */
    mintedSubject?: string,
  ): Held | undefined => {
    if (custody.size === 0) {
      return undefined;
    }
    const agentId = ctx.agentId?.toLowerCase();
    if (
      !agentId ||
      !isAdminAgent(config, agentId) ||
      !SANDBOX_TOOLS.has(toolName) ||
      !ctx.sessionKey
    ) {
      return undefined;
    }
    const sessionKey = ctx.sessionKey.toLowerCase();
    const sandbox = sandboxKey(agentId, sessionKey);
    const holder = custody.get(sandbox);
    if (!holder) {
      return undefined;
    }
    if (holder.expiresAt <= Date.now()) {
      custody.delete(sandbox);
      return undefined;
    }
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    if (
      run?.agentId === agentId &&
      run.sessionKey === sessionKey &&
      run.sender === holder.sender &&
      continuationCurrent(run, ctx)
    ) {
      return undefined;
    }
    // The same person on another channel: only a token Fi minted for the
    // holder's own subject, in a session the holder's commands ran in.
    if (
      mintedSubject !== undefined &&
      holder.subject === mintedSubject &&
      sameSessionCandidate(config, toolName, ctx, holder)
    ) {
      return undefined;
    }
    return { block: true, blockReason: run?.sender ? heldCopy(holder.expiresAt) : UNPROVEN_HOLD };
  };

  /**
   * With crossChannelCustody, a minting tool of a proven run in a session the
   * holder's own commands ran in, whatever channel identity proved it. It may
   * ask Fi; the post-mint check on the token's subject decides. Tools that do
   * not mint, unproven runs and other sessions stay held.
   */
  const sameSessionCandidate = (
    config: ResolvedPluginConfig,
    toolName: string,
    ctx: PluginHookToolContext,
    holder: Custody,
  ): boolean => {
    const agentId = ctx.agentId?.toLowerCase();
    const sessionKey = ctx.sessionKey?.toLowerCase();
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    return (
      config.crossChannelCustody === true &&
      ON_BEHALF_OF_TOOLS.has(toolName) &&
      run !== undefined &&
      run.sender !== undefined &&
      run.agentId === agentId &&
      run.sessionKey === sessionKey &&
      continuationCurrent(run, ctx) &&
      [...holder.calls.values()].some((call) => call.sessionKey.toLowerCase() === sessionKey)
    );
  };

  /** Whether a call `held` refused may still ask Fi, to be decided on the minted subject. */
  const decidesAfterMint = (
    config: ResolvedPluginConfig,
    toolName: string,
    ctx: PluginHookToolContext,
  ): boolean => {
    const agentId = ctx.agentId?.toLowerCase();
    const holder =
      agentId && ctx.sessionKey
        ? custody.get(sandboxKey(agentId, ctx.sessionKey.toLowerCase()))
        : undefined;
    return (
      holder !== undefined &&
      holder.expiresAt > Date.now() &&
      sameSessionCandidate(config, toolName, ctx, holder)
    );
  };

  /**
   * The token for this tool call, the reason the call may not run, or nothing.
   * Synchronous refusals stay synchronous so a call that gets no token is not
   * delayed by asking Fi. A sandbox is held only for a token that is returned.
   */
  const mint = (
    config: ResolvedPluginConfig,
    event: { toolName: string; toolKind?: string; params: Record<string, unknown> },
    ctx: PluginHookToolContext,
    /** When the host entered this tool call's hook; its deadline runs from then. */
    enteredAt: number,
  ): Promise<CommandDelegation | Held | undefined> | undefined => {
    const environment = ctx.hostHookFiEnvironment;
    if (!environment) {
      return mintFrom(config, event, ctx, enteredAt);
    }
    // A hook run answers to the Fi that sent it: every credential is minted by
    // that environment's own broker and carries its origin.
    const routed = withHookFiRoute(config, environment);
    const result = routed ? mintFrom(routed, event, ctx, enteredAt) : undefined;
    // Where the sandbox's own default Fi is another environment, a command
    // that gets no token for the hook's Fi must not fall through to it.
    if (
      (routed && routed.baseUrl === config.baseUrl.replace(/\/+$/, "")) ||
      !ON_BEHALF_OF_TOOLS.has(event.toolName) ||
      !runsInSandbox(event.params)
    ) {
      return result;
    }
    const refused: Held = {
      block: true,
      blockReason: `This turn answers to the ${environment} Fi. A command that cannot carry that Fi's own credential cannot run here, because this sandbox's default Fi is another environment.`,
    };
    return result ? result.then((value) => value ?? refused) : Promise.resolve(refused);
  };

  const mintFrom = (
    config: ResolvedPluginConfig,
    event: { toolName: string; toolKind?: string; params: Record<string, unknown> },
    ctx: PluginHookToolContext,
    enteredAt: number,
  ): Promise<CommandDelegation | Held | undefined> | undefined => {
    const agentId = ctx.agentId?.toLowerCase();
    const operatorProof = admittedOperatorCommand(ctx);
    const operatorRequested =
      config.operatorAgentId === "cellect-main" &&
      !config.tenantOrgId &&
      ON_BEHALF_OF_TOOLS.has(event.toolName) &&
      typeof event.params.command === "string" &&
      operationCommandArgs(event.params.command) !== undefined;
    if (config.operatorAgentId === "cellect-main" && !operatorRequested) {
      return undefined;
    }
    if (
      !agentId ||
      (!config.tenantOrgId && !operatorProof) ||
      !isAdminAgent(config, agentId) ||
      !ON_BEHALF_OF_TOOLS.has(event.toolName) ||
      event.toolKind ||
      ctx.toolKind ||
      !runsInSandbox(event.params) ||
      !ctx.sessionKey ||
      // An approved admin action keeps today's attribution; it is not this turn's requester.
      adminActionSessions.has(ctx.sessionKey) ||
      !posture(agentId).pinIsHarmless ||
      // Talk never borrows a typed run's sender: only the native owner admits this exception.
      (posture(agentId).servesTalk && !operatorProof)
    ) {
      if (isAdminAgent(config, ctx.agentId) && ON_BEHALF_OF_TOOLS.has(event.toolName)) {
        diagnose(ctx, "mint-ineligible", () => ({
          tenantConfigured: Boolean(config.tenantOrgId),
          toolKindPresent: Boolean(event.toolKind || ctx.toolKind),
          sandboxParameters: runsInSandbox(event.params),
          sessionPresent: Boolean(ctx.sessionKey),
          approvedActionSession: Boolean(ctx.sessionKey && adminActionSessions.has(ctx.sessionKey)),
          safePosture: posture(agentId ?? config.adminAgentId).pinIsHarmless,
        }));
      }
      return operatorRequested ? Promise.resolve(operationCommandFailure()) : undefined;
    }
    const sessionKey = ctx.sessionKey.toLowerCase();
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    const mail = mailWakeRequester(
      ctx.hookMailWakeSessionKey ?? sessionKey,
      ctx.requester?.senderId,
    );
    const requester =
      mail ??
      onBehalfOfRequester(run?.continuation ?? ctx.requester) ??
      matrixOriginRequester(run, ctx.requester?.senderId);
    const suppliedRequester = onBehalfOfRequester(ctx.requester);
    const sender = requester && JSON.stringify(requester);
    if (
      !run ||
      !requester ||
      !sender ||
      run.agentId !== agentId ||
      run.sessionKey !== sessionKey ||
      !sessionKey.startsWith(`agent:${agentId}:`) ||
      run.sender !== sender ||
      !continuationCurrent(run, ctx) ||
      (run.continuation && suppliedRequester && JSON.stringify(suppliedRequester) !== sender) ||
      (run.voice && admittedVoiceTurn(ctx) !== run.voice)
    ) {
      diagnose(ctx, "mint-run-unproven", () => ({
        runPresent: Boolean(run),
        requesterPresent: Boolean(requester),
        runAdmitted: Boolean(run?.sender),
        sameSession: run?.sessionKey === sessionKey,
        sameSender: Boolean(sender && run?.sender === sender),
        voiceProofCurrent: !run?.voice || admittedVoiceTurn(ctx) === run.voice,
      }));
      return operatorRequested ? Promise.resolve(operationCommandFailure()) : undefined;
    }
    let body: Record<string, string>;
    let connection: Pick<ResolvedPluginConfig, "baseUrl" | "brokerTokenEnv"> | undefined;
    if ("requester_slack_user_id" in requester) {
      body = { requesterSenderId: requester.requester_slack_user_id };
      connection = config;
    } else if ("requester_matrix_user_id" in requester) {
      body = { requesterMatrixUserId: requester.requester_matrix_user_id };
      // A source-session reply names its Matrix account at dispatch; the tool
      // context may carry the Slack session's account instead.
      const originAccount = run.matrixOrigin?.accountId;
      // A run admitted from a source-session reply uses that reply's own Matrix
      // account, or the tool's only when the host labels the call Matrix; a
      // Slack account reported for the session never selects the environment.
      const toolMatrixAccount =
        ctx.requester?.channel === "matrix" ? ctx.requester.accountId : undefined;
      connection = run.matrixOrigin
        ? originAccount && toolMatrixAccount !== undefined && toolMatrixAccount !== originAccount
          ? undefined
          : matrixConnection(config, originAccount ?? toolMatrixAccount)
        : matrixConnection(config, run.continuation?.accountId ?? ctx.requester?.accountId);
    } else if (mail && "requester_email" in requester) {
      body = { requesterEmail: requester.requester_email };
      connection = config;
    } else {
      diagnose(ctx, "mint-unsupported-requester");
      return undefined;
    }
    if (mail) {
      try {
        mailWakeDelegationContext(ctx);
      } catch {
        return Promise.resolve({
          block: true,
          blockReason:
            "This mail wake has no current host source receipt; rebind it before running a Fi command",
        });
      }
      connection = mailWakeConnection(config, ctx.hostMailWakeEnvironment);
    }
    connection = connection && { ...connection, baseUrl: connection.baseUrl.replace(/\/+$/, "") };
    const crossEnvironmentFailure: Held | undefined =
      connection && connection.baseUrl.replace(/\/+$/, "") !== config.baseUrl.replace(/\/+$/, "")
        ? {
            block: true,
            blockReason:
              "The requester could not be verified for this Matrix environment. Start a fresh command; this call cannot fall back to the sandbox default Fi.",
          }
        : undefined;
    // An explicit different origin cannot receive this Fi's token. A selected
    // environment must not fall through to the sandbox's ambient Fi either.
    if (!connection || namesAnotherFi(event.params, connection.baseUrl.replace(/\/+$/, ""))) {
      diagnose(ctx, "mint-connection-unavailable", () => ({
        connectionConfigured: Boolean(connection),
        sameFiOrigin: Boolean(
          connection && !namesAnotherFi(event.params, connection.baseUrl.replace(/\/+$/, "")),
        ),
      }));
      return operatorRequested
        ? Promise.resolve(operationCommandFailure())
        : crossEnvironmentFailure
          ? Promise.resolve(crossEnvironmentFailure)
          : undefined;
    }
    // Raw shell work can persist an environment credential in arbitrary files.
    // Do not issue it a token and then reserve the entire thread until expiry.
    // The maintained command's no-persistence contract and native cleanup identity
    // are both required before asking Fi to mint a command credential.
    const pinnedCommand = posture(agentId).readonlyCli
      ? pinInstalledFiCliCommand(event.params)
      : undefined;
    const runId = ctx.runId,
      toolCallId = ctx.toolCallId;
    const key = runId && toolCallId && JSON.stringify([runId, toolCallId]);
    if (pinnedCommand === undefined || !key || !runId || !toolCallId) {
      return operatorRequested
        ? Promise.resolve(operationCommandFailure())
        : crossEnvironmentFailure
          ? Promise.resolve(crossEnvironmentFailure)
          : undefined;
    }
    const canTrack = () => {
      const calls = custody.get(sandboxKey(agentId, sessionKey))?.calls;
      return !calls?.has(key) && (calls?.size ?? 0) < MAX_TRACKED;
    };
    if (!canTrack()) {
      return operatorRequested
        ? Promise.resolve(operationCommandFailure())
        : crossEnvironmentFailure
          ? Promise.resolve(crossEnvironmentFailure)
          : undefined;
    }
    const budget = Math.min(MAX_MINT_MS, HOOK_BUDGET_MS - (Date.now() - enteredAt));
    if (budget < MIN_MINT_MS) {
      diagnose(ctx, "mint-budget-exhausted");
      return operatorRequested
        ? Promise.resolve(operationCommandFailure())
        : crossEnvironmentFailure
          ? Promise.resolve(crossEnvironmentFailure)
          : undefined;
    }
    let wakeContext: ReturnType<typeof mailWakeDelegationContext>;
    try {
      wakeContext = mailWakeDelegationContext(ctx);
    } catch {
      return Promise.resolve({
        block: true,
        blockReason:
          "This mail wake has no current host source receipt; rebind it before running a Fi command",
      });
    }
    Object.assign(body, wakeContext);
    const baseUrl = connection.baseUrl;
    const sandbox = sandboxKey(agentId, sessionKey);
    const issued = operatorProof
      ? requestOperationCommandReceipt({
          turn: operatorProof,
          command: pinnedCommand,
          runId,
          toolCallId,
          connection,
          signal: AbortSignal.any([
            AbortSignal.timeout(budget),
            operatorProof.authorization.signal,
            ...(ctx.abortSignal ? [ctx.abortSignal] : []),
          ]),
          assertCurrent: () => {
            if (
              admittedOperatorCommand(ctx) !== operatorProof ||
              runs.get(ctx.runId ?? "") !== run ||
              run.sender !== sender
            ) {
              throw new Error("Native command requester changed");
            }
          },
        })
      : lookupDelegation({ ...config, ...connection }, body, {
          agentId: FI_ADMIN_DELEGATION_AGENT_ID,
          mailWakeEnvironment: ctx.hostMailWakeEnvironment,
          signal: AbortSignal.timeout(budget),
          ...("requesterMatrixUserId" in body
            ? { turn: delegationTurnFor(api, ctx) ?? matrixOriginTurn(run) }
            : {}),
        }).then((delegation) =>
          delegation
            ? { token: delegation.fi?.token, expiresAt: delegation.fi?.expiresAt }
            : undefined,
        );
    return issued.then(
      (credential) => {
        // Other operator commands retain their existing execution path.
        if (operatorProof && !credential) {
          return undefined;
        }
        const token: unknown = credential?.token;
        const expiresAt: unknown = credential?.expiresAt;
        const now = Date.now();
        if (
          typeof token !== "string" ||
          !JWT.test(token) ||
          typeof expiresAt !== "number" ||
          expiresAt * 1000 - now < MIN_REMAINING_SECONDS * 1000 ||
          expiresAt * 1000 - now > (operatorProof ? 120_000 : MAX_HOLD_MS) ||
          ctx.abortSignal?.aborted ||
          runs.get(ctx.runId ?? "") !== run ||
          run.sender !== sender ||
          !posture(agentId).pinIsHarmless ||
          (operatorProof && admittedOperatorCommand(ctx) !== operatorProof) ||
          !continuationCurrent(run, ctx) ||
          (run.voice && admittedVoiceTurn(ctx) !== run.voice)
        ) {
          diagnose(ctx, "mint-reply-invalid", () => ({
            tokenShapeValid: typeof token === "string" && JWT.test(token),
            expiryNumeric: typeof expiresAt === "number",
            lifetimeEnough:
              typeof expiresAt === "number" &&
              expiresAt * 1000 - now >= MIN_REMAINING_SECONDS * 1000,
            lifetimeBounded: typeof expiresAt === "number" && expiresAt * 1000 - now <= MAX_HOLD_MS,
            runAborted: ctx.abortSignal?.aborted === true,
            currentRun: runs.get(ctx.runId ?? "") === run,
            sameSender: run.sender === sender,
            voiceProofCurrent: !run.voice || admittedVoiceTurn(ctx) === run.voice,
          }));
          return operatorProof ? operationCommandFailure() : crossEnvironmentFailure;
        }
        // Someone else's token may have reached this sandbox while Fi answered:
        // the call must then wait like any other, not run without a token.
        // With crossChannelCustody the token's own subject may match the
        // holder's; a token for anyone else is dropped here, never injected.
        const subject = config.crossChannelCustody === true ? tokenSubject(token) : undefined;
        const blocked = held(config, event.toolName, ctx, subject);
        if (blocked) {
          diagnose(ctx, "mint-held");
          return blocked;
        }
        if (!canTrack()) {
          return operatorProof ? operationCommandFailure() : crossEnvironmentFailure;
        }
        // Expiry is a fallback, not a minimum hold: native descendant cleanup
        // releases only this exact call, never another still-running command.
        const holder: Custody = custody.get(sandbox) ?? {
          sender,
          expiresAt: 0,
          calls: new Map(),
          ...(subject !== undefined ? { subject } : {}),
        };
        if (holder.subject !== subject) {
          delete holder.subject;
        }
        const expiry = Math.min(expiresAt * 1000, now + MAX_HOLD_MS);
        holder.calls.set(key, { agentId, sessionKey: ctx.sessionKey!, expiresAt: expiry });
        holder.expiresAt = Math.max(holder.expiresAt, expiry);
        remember(custody, sandbox, holder);
        diagnose(ctx, "mint-issued");
        return {
          token,
          baseUrl,
          command: pinnedCommand,
          ...(operatorProof ? { operationReceipt: true as const } : {}),
        };
      },
      (error: unknown) => {
        // Status only: the failure may quote the request, which carries the credential.
        const status = /\((\d{3})\)$/.exec(error instanceof Error ? error.message : "")?.[1];
        diagnose(ctx, "mint-request-failed", () => ({
          httpStatusPresent: Boolean(status),
          httpUnauthorized: status === "401",
          httpForbidden: status === "403",
        }));
        api.logger.warn(
          `fi-user: admin delegation not issued (${status ? `status ${status}` : "unavailable"})`,
        );
        return operatorProof ? operationCommandFailure() : crossEnvironmentFailure;
      },
    );
  };

  /**
   * The person this Fi-admin tool call's run was proven to act for, and the Fi
   * that answers for them: the same proof a sandbox command needs for its
   * token, for a Fi call the plugin makes itself. Nothing when unproven.
   */
  const provenToolRequester = (
    ctx: Parameters<RequesterProofReader>[0],
    reportAttachmentFailure = false,
  ) => {
    const environment = ctx.hostHookFiEnvironment;
    const proven = provenRequester(ctx, environment, reportAttachmentFailure);
    if (!proven || !environment) {
      return proven;
    }
    // A hook run is answered only by the Fi it named, whichever branch proved it.
    const route = withHookFiRoute(proven.connection, environment);
    if (
      route &&
      route.baseUrl === proven.connection.baseUrl.replace(/\/+$/, "") &&
      route.brokerTokenEnv === proven.connection.brokerTokenEnv
    ) {
      return proven;
    }
    if (reportAttachmentFailure) diagnose(ctx, "attachment-requester-route-unavailable");
    return undefined;
  };

  const provenRequester = (
    ctx: Parameters<RequesterProofReader>[0],
    environment: "dev" | "staging" | "prod" | undefined,
    reportAttachmentFailure: boolean,
  ): ReturnType<RequesterProofReader> => {
    const config = withHookFiRoute(configFromRuntime(api), environment);
    if (!config) {
      if (reportAttachmentFailure) diagnose(ctx, "attachment-requester-route-unavailable");
      return undefined;
    }
    const agentId = ctx.agentId?.toLowerCase();
    const sessionKey = ctx.sessionKey?.toLowerCase();
    const run = ctx.runId ? runs.get(ctx.runId) : undefined;
    const channel = run?.continuation ?? {
      channel: ctx.messageChannel,
      senderId: ctx.requesterSenderId,
    };
    const requester =
      mailWakeRequester(ctx.hookMailWakeSessionKey ?? sessionKey, ctx.requesterSenderId) ??
      onBehalfOfRequester(channel) ??
      matrixOriginRequester(run, ctx.requesterSenderId);
    if (
      !config.tenantOrgId ||
      !agentId ||
      agentId !== config.adminAgentId.toLowerCase() ||
      !sessionKey ||
      adminActionSessions.has(ctx.sessionKey!) ||
      !run ||
      !requester ||
      run.agentId !== agentId ||
      run.sessionKey !== sessionKey ||
      run.sender !== JSON.stringify(requester) ||
      (run.continuation &&
        !continuationCurrent(run, {
          runId: ctx.runId,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          sessionId: run.continuation.sessionId,
          requesterContinuation: run.continuation,
        })) ||
      (run.voice &&
        admittedVoiceTurn({
          runId: ctx.runId,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          requester: { ...channel, accountId: ctx.agentAccountId },
        }) !== run.voice)
    ) {
      if (reportAttachmentFailure) {
        diagnose(ctx, "attachment-requester-unproven", () => ({
          tenantPresent: Boolean(config.tenantOrgId),
          agentMatches: Boolean(agentId && agentId === config.adminAgentId.toLowerCase()),
          sessionPresent: Boolean(sessionKey),
          runPresent: Boolean(run),
          runAgentMatches: Boolean(run && run.agentId === agentId),
          runSessionMatches: Boolean(run && run.sessionKey === sessionKey),
          requesterPresent: Boolean(requester),
          requesterMatches: Boolean(requester && run?.sender === JSON.stringify(requester)),
          senderPresent: Boolean(run?.sender),
          adminActionSession: adminActionSessions.has(ctx.sessionKey ?? ""),
          hasContinuation: Boolean(run?.continuation),
          hasVoiceTurn: Boolean(run?.voice),
        }));
      }
      return undefined;
    }
    const isMailSource = Boolean(
      ctx.hookMailWakeSessionKey || /(?:^|:)hook:fi-mail:/i.test(sessionKey ?? ""),
    );
    const sourceConnection = isMailSource
      ? mailWakeConnection(config, ctx.hostMailWakeEnvironment)
      : undefined;
    if (isMailSource && !sourceConnection) {
      if (reportAttachmentFailure) diagnose(ctx, "attachment-requester-route-unavailable");
      return undefined;
    }
    if ("requester_slack_user_id" in requester) {
      return {
        connection: sourceConnection ? { ...config, ...sourceConnection } : config,
        body: {
          requesterSenderId: requester.requester_slack_user_id,
          ...mailWakeDelegationContext(ctx),
        },
      };
    }
    if ("requester_email" in requester) {
      return {
        connection: { ...config, ...sourceConnection },
        body: { requesterEmail: requester.requester_email, ...mailWakeDelegationContext(ctx) },
      };
    }
    if (!("requester_matrix_user_id" in requester)) {
      return undefined;
    }
    const matrix = run.matrixOrigin
      ? matrixConnection(
          config,
          run.matrixOrigin.accountId ??
            (ctx.messageChannel === "matrix" ? ctx.agentAccountId : undefined),
        )
      : matrixConnection(config, run.continuation?.accountId ?? ctx.agentAccountId);
    if (!matrix && reportAttachmentFailure) {
      diagnose(ctx, "attachment-requester-route-unavailable", () => ({
        accountPresent: Boolean(ctx.agentAccountId),
        sourceAccountPresent: Boolean(run.matrixOrigin?.accountId),
        continuationAccountPresent: Boolean(run.continuation?.accountId),
      }));
    }
    return matrix
      ? {
          connection: { ...config, ...matrix, baseUrl: matrix.baseUrl.replace(/\/+$/, "") },
          body: {
            requesterMatrixUserId: requester.requester_matrix_user_id,
            ...mailWakeDelegationContext(ctx),
          },
          turn: delegationTurnFor(api, ctx) ?? matrixOriginTurn(run),
        }
      : undefined;
  };
  return { held, decidesAfterMint, mint, provenToolRequester };
}
