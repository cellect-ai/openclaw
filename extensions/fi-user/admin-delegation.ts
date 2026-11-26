import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { adminCommandPosture } from "./admin-command-sandbox.js";
import { createAdminDelegationDiagnostic } from "./admin-delegation.diagnostics.js";
import { createAdminDelegationIngress } from "./admin-delegation.ingress.js";
import { createAdminDelegationMint } from "./admin-delegation.mint.js";
import {
  REQUESTER_LINE_MINT_MS,
  MAX_TRACKED,
  ARRIVAL_TTL_MS,
  NOTICE_GRACE_MS,
  UNPROVEN,
  type Arrivals,
  type Proof,
  type Custody,
  type NoticeRoute,
  INJECTED_NOTICE,
  remember,
  type Run,
  continuationCurrent,
  type Inbound,
} from "./admin-delegation.shared.js";
import {
  configFromRuntime,
  isAdminAgent,
  FI_ADMIN_DELEGATION_AGENT_ID,
  FI_USER_AGENT_ID,
  lookupRequesterEmail,
  requesterContextLine,
  REQUESTER_UNCONFIRMED_LINE,
} from "./fi-delegation.js";
import type { MatrixEntitlements } from "./matrix-entitlements.js";
import { mailWakeRequester, onBehalfOfRequester, talkConsultSender } from "./on-behalf-of.js";
import {
  forgetAllProjectedMatrixRuns,
  forgetProjectedMatrixRun,
  forgetProjectedMatrixSession,
  rememberProjectedMatrixRun,
} from "./projected-matrix-runs.js";

/**
 * The requester's own Fi token for one admin-agent shell command.
 *
 * Fi mints it for the person the host proved sent the message that started
 * this turn, and it reaches only the commands Fi lists for the admin agent. It
 * is asked for per call and returned to the caller for that call's `env`:
 * nothing here keeps a token. Failure yields none for the existing same-Fi
 * operator path; an eligible turn selecting another Fi must instead block.
 *
 * A tool call names its requester but not what started its run, and the host
 * reuses a stored sender when it resumes a run. So a turn is admitted only by
 * what arrived for it: everything observed for the session since a message
 * run last took it up must come from one sender, the channel must have proven
 * that sender on a dispatched message, the run must be a user turn by that
 * same sender, and nobody else may write into the session while it runs.
 * Cron, heartbeat, webhook, sub-agent and inter-session runs bring no such
 * message; a batch from several people and a run another person steers are
 * refused. A shared-mail hook is the exception: its session is `hook:fi-mail:`
 * and its sender was attested by the authenticated hooks caller, so that
 * cron turn is the named member.
 *
 * A Slack session must be the sender's own direct one. A Matrix room or thread
 * is admitted one message at a time (owner decision, 2026-10-06): the run must
 * also be the one the host started for that very room event, so the token is
 * that run's and that sender's, and the next run in the thread stands on its
 * own message. The agent still reads other people's words in the room without
 * their being dispatched to it; Fi decides whether the sender is an admin.
 *
 * An arrival waits six hours for a message run: a message queued behind a long
 * run still counts when it is collected with a later one, at the price of one
 * refused turn for the owner after someone else's message was steered in.
 *
 * A token is issued only where pinning its command to the sandbox changes
 * nothing for the deployment: the admin agent always runs sandboxed, its exec
 * host is the sandbox, and elevation is off. Elsewhere nothing is issued and
 * nothing is pinned. Credential-bearing commands require native process-tree
 * cleanup. Only a direct immutable installed CLI call with a unique native call
 * identity receives a token; raw shell work never receives requester credentials.
 * The sandbox is reserved until each exact command's cleanup is proven,
 * with token expiry as the fallback for missing or failed proof. This relies on
 * the installed CLI's no-credential-persistence contract; process extinction is
 * not a claim that arbitrary shell writes to shared files have been erased.
 *
 * Matrix-bound voice consults use the Matrix entitlement owner's admitted
 * speaker/run identity, not synthetic message arrivals or a session-wide flag.
 * Accepted consults may outlive their audio relay; the host retains their run
 * authority and checks it again at tool execution, including after awaited hooks.
 */
export function registerAdminDelegation(
  api: OpenClawPluginApi,
  admittedVoiceTurn: MatrixEntitlements["admittedVoiceTurn"] = () => undefined,
  admittedOperatorCommand: MatrixEntitlements["admittedOperatorCommand"] = () => undefined,
) {
  const { diagnose } = createAdminDelegationDiagnostic(api);
  const arrivals = new Map<string, Arrivals>();
  const runs = new Map<string, Run>();
  const custody = new Map<string, Custody>();
  /**
   * Verified Matrix replies dispatched into a Fi-user Slack session, by session
   * then event: the run started for that exact event, by that sender, takes it.
   */
  const fiUserReplies = new Map<
    string,
    Map<string, { matrixUserId: string; roomId: string; accountId?: string }>
  >();
  /**
   * Fi-user sessions someone else wrote into since a run last started there: a
   * run that may carry their queued words proves nobody, as on the admin side.
   */
  const fiUserTainted = new Set<string>();
  /** Events (session, event id) the host was told to queue rather than steer. */
  const queuedBySteerGate = new Set<string>();
  /**
   * Proofs that `received` took from active runs for a channel message, by (session, event id), so
   * that a message the host then queues instead of injecting gives them back: only an injected
   * input can have changed what a run does, and a queued one runs on its own proof.
   */
  const strippedByArrival = new Map<string, Array<[Run, string, number]>>();
  const trimSet = (set: Set<string>, max: number): void => {
    for (const oldest of set) {
      if (set.size <= max) {
        break;
      }
      set.delete(oldest);
    }
  };
  /** Notices waiting out NOTICE_GRACE_MS after their run settled, by session. */
  const pendingNotices = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  const cancelNotices = (sessionKey: string): void => {
    for (const timer of pendingNotices.get(sessionKey) ?? []) {
      clearTimeout(timer);
    }
    pendingNotices.delete(sessionKey);
  };
  const reset = () => {
    for (const key of pendingNotices.keys()) {
      cancelNotices(key);
    }
    fiUserTainted.clear();
    queuedBySteerGate.clear();
    strippedByArrival.clear();
    arrivals.clear();
    runs.clear();
    fiUserReplies.clear();
    forgetAllProjectedMatrixRuns();
  };

  const { fiUserInbound, inboundRequester, provenSender } = createAdminDelegationIngress(
    api,
    fiUserReplies,
    fiUserTainted,
  );
  const posture = (adminAgentId: string) =>
    adminCommandPosture(api.runtime.config?.current?.() ?? api.config, adminAgentId);
  /** One sandbox per session only under that scope; otherwise the agent's sessions share it. */
  const sandboxKey = (adminAgentId: string, sessionKey: string): string =>
    posture(adminAgentId).scope === "session" ? sessionKey : `agent:${adminAgentId.toLowerCase()}`;

  const { held, decidesAfterMint, mint, provenToolRequester } = createAdminDelegationMint(api, {
    admittedVoiceTurn,
    admittedOperatorCommand,
    runs,
    custody,
    posture,
    sandboxKey,
    diagnose,
  });
  api.agent.events.registerAgentEventSubscription({
    id: "admin-delegation-turn-retirement",
    streams: ["lifecycle", "sandbox_process"],
    handle(event) {
      if (event.stream === "sandbox_process" && event.data.phase === "cleanup-complete") {
        const callId = event.data.toolCallId;
        if (typeof callId !== "string") {
          return;
        }
        const key = JSON.stringify([event.runId, callId]);
        for (const [sandbox, holder] of custody) {
          const call = holder.calls.get(key);
          if (
            !call ||
            event.data.sessionKey !== call.sessionKey ||
            event.data.agentId !== call.agentId
          ) {
            continue;
          }
          holder.calls.delete(key);
          holder.expiresAt = Math.max(
            0,
            ...[...holder.calls.values()].map((pending) => pending.expiresAt),
          );
          if (holder.expiresAt <= Date.now()) {
            custody.delete(sandbox);
          }
        }
        return;
      }
      if (
        event.data.executionSettled === true &&
        (event.data.phase === "end" || event.data.phase === "error")
      ) {
        const settled = runs.get(event.runId);
        if (settled?.notice) {
          scheduleNotice(settled.sessionKey, settled.notice);
        }
        runs.delete(event.runId);
        forgetProjectedMatrixRun(event.runId);
      }
    },
  });
  api.lifecycle.registerRuntimeLifecycle({
    id: "admin-delegation-turns",
    dispose: reset,
    cleanup: ({ runId, sessionKey }) => {
      if (runId) {
        runs.delete(runId);
        forgetProjectedMatrixRun(runId);
      } else if (sessionKey) {
        const key = sessionKey.toLowerCase();
        cancelNotices(key);
        arrivals.delete(key);
        fiUserReplies.delete(key);
        fiUserTainted.delete(key);
        forgetProjectedMatrixSession(key);
        for (const [id, run] of runs) {
          if (run.sessionKey === key) {
            runs.delete(id);
          }
        }
      } else {
        reset();
      }
    },
  });
  /**
   * State the requester's own Fi email in this admin turn's own input, so
   * `--actor` is never guessed. The email is Fi's answer to a mint for exactly
   * this run's sender: asked at prompt build, per run, never cached or reused
   * for another sender in a shared room. The minted token is not kept or
   * injected anywhere; no sandbox is held.
   *
   * It is per-turn context (`prependContext`), not system context: on the
   * Codex harness system context becomes the thread's generic policy, which is
   * persisted in the native thread. A user turn without a confirmed email
   * (no proof, no answer, or a sender change while Fi answered) says so, so an
   * earlier turn's line in shared history is never taken for this sender's.
   * (Registered before before_agent_reply, which stays this owner's last hook.)
   */
  api.on("before_prompt_build", async (_event, context) => {
    const runId = context.runId;
    const agentId = context.agentId?.toLowerCase();
    if (!runId || !agentId || agentId !== configFromRuntime(api).adminAgentId.toLowerCase()) {
      return undefined;
    }
    // A mail wake carries Fi's own line in its message; other non-user runs name nobody.
    const unconfirmed =
      context.trigger === "user" ? { prependContext: REQUESTER_UNCONFIRMED_LINE } : undefined;
    const run = runs.get(runId);
    const sender = run?.sender;
    const proof = provenToolRequester({
      runId,
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      messageChannel: context.channel,
      requesterSenderId: context.senderId,
      agentAccountId: context.accountId,
      hookSourceLockCapability: context.hookSourceLockCapability,
      hookMailWakeSessionKey: context.hookMailWakeSessionKey,
      hostMailWakeEnvironment: context.hostMailWakeEnvironment,
    });
    if (!proof || !run || !sender) {
      return unconfirmed;
    }
    try {
      const email = await lookupRequesterEmail(proof.connection, proof.body, {
        agentId: FI_ADMIN_DELEGATION_AGENT_ID,
        mailWakeEnvironment: context.hostMailWakeEnvironment,
        signal: AbortSignal.timeout(REQUESTER_LINE_MINT_MS),
      });
      if (!email || runs.get(runId) !== run || run.sender !== sender) {
        return unconfirmed;
      }
      return { prependContext: requesterContextLine(email) };
    } catch {
      return unconfirmed;
    }
  });

  api.on(
    "before_agent_reply",
    (_event, context) => {
      const config = configFromRuntime(api);
      const sessionKey = context.sessionKey?.toLowerCase();
      const runId = context.runId;
      const agentId = context.agentId?.toLowerCase();
      if (agentId === FI_USER_AGENT_ID && sessionKey && runId) {
        // Only the run of the exact verified event, by that same person, in its room.
        const origin = context.channelContext;
        const eventId = typeof origin?.chat?.eventId === "string" ? origin.chat.eventId : undefined;
        const replies = fiUserReplies.get(sessionKey);
        const reply = eventId ? replies?.get(eventId) : undefined;
        // A run takes up everything queued for the session so far.
        const tainted = fiUserTainted.delete(sessionKey);
        if (eventId) {
          replies?.delete(eventId);
        }
        if (
          reply &&
          !tainted &&
          context.trigger === "user" &&
          context.senderId?.trim() === reply.matrixUserId &&
          origin?.sender?.id === reply.matrixUserId &&
          origin.sender.isBot !== true &&
          origin.chat?.id === reply.roomId
        ) {
          rememberProjectedMatrixRun(runId, {
            sessionKey,
            matrixUserId: reply.matrixUserId,
            ...(reply.accountId ? { accountId: reply.accountId } : {}),
          });
        }
        return undefined;
      }
      if (!agentId || !isAdminAgent(config, agentId)) {
        return undefined;
      }
      if (!sessionKey || !sessionKey.startsWith(`agent:${agentId}:`) || !runId || runs.has(runId)) {
        diagnose(
          { runId, sessionKey },
          runs.has(runId ?? "") ? "turn-already-observed" : "turn-context-incomplete",
          () => ({
            sessionPresent: Boolean(sessionKey),
          }),
        );
        return undefined;
      }
      // Remembered whether admitted or not, so a second attempt of the same
      // run does not take up what arrived for the next one.
      const run: Run = { agentId, sessionKey };
      remember(runs, runId, run);
      // A run that may carry a message started: whatever input a settled run
      // left waiting for a notice may be its own (queued, not steered), so say
      // nothing. Only cron and heartbeat runs never carry one.
      if (context.trigger !== "cron" && context.trigger !== "heartbeat") {
        cancelNotices(sessionKey);
      }
      const continuation = context.requesterContinuation;
      if (continuation) {
        run.continuation = continuation;
        const requester = onBehalfOfRequester(continuation);
        if (requester && continuation.sourceTurnId && continuationCurrent(run, context)) {
          run.sender = JSON.stringify(requester);
        }
        diagnose({ runId, sessionKey }, run.sender ? "turn-admitted" : "turn-unproven");
        return undefined;
      }
      // A shared-mail hook is a cron turn whose sender the hooks caller
      // attested. It does not consume a channel arrival.
      if (context.trigger === "cron") {
        const mail = mailWakeRequester(
          context.hookMailWakeSessionKey ?? sessionKey,
          context.senderId,
        );
        if (mail) {
          run.sender = JSON.stringify(mail);
        }
        return undefined;
      }
      // Only a run that carries a message takes up what arrived; a heartbeat
      // or inter-session run in between must not clear a queued message.
      if (context.trigger !== "user" || !context.senderId) {
        diagnose({ runId, sessionKey }, "turn-not-user", () => ({
          userTriggered: context.trigger === "user",
          senderPresent: Boolean(context.senderId),
        }));
        return undefined;
      }
      if (context.channelContext?.chat?.talkThreadRootEventId !== undefined) {
        const voice = admittedVoiceTurn({
          agentId: context.agentId,
          runId,
          sessionKey: context.sessionKey,
          requester: {
            channel: context.channel,
            senderId: context.senderId,
            accountId: context.accountId,
          },
        });
        if (voice && context.channelContext.sender?.isBot !== true) {
          const requester = onBehalfOfRequester({ channel: "matrix", senderId: voice.senderId });
          const sender = requester && JSON.stringify(requester);
          if (sender) {
            // A new speaker invalidates other people's in-flight command proof.
            // Do not consume queued text arrivals: their event proves their own run.
            for (const active of runs.values()) {
              if (active.sessionKey === sessionKey && active.sender !== sender) {
                delete active.sender;
              }
            }
            run.sender = sender;
            run.voice = voice;
          }
        }
        diagnose({ runId, sessionKey }, run.sender ? "turn-admitted" : "turn-unproven", () => ({
          voiceTurn: true,
          ownerAdmitted: Boolean(voice),
          senderIsBot: context.channelContext?.sender?.isBot === true,
          requesterPresent: Boolean(run.sender),
        }));
        return undefined;
      }
      const arrived = arrivals.get(sessionKey);
      arrivals.delete(sessionKey);
      // Shared conversations admit only the run of the dispatched native event,
      // by that same sender. Never reuse the stored sender on a synthetic wake.
      const origin = context.channelContext;
      const rest = sessionKey.slice(`agent:${agentId}:`.length);
      const originEventId =
        typeof origin?.chat?.eventId === "string" ? origin.chat.eventId : undefined;
      // The host reports a Slack session's channel for a run its Matrix
      // projection started. The verified dispatch of that very event names the
      // Matrix person; the run's own sender must be that person.
      const sourceOrigin =
        originEventId && rest.startsWith("slack:")
          ? arrived?.sourceSenders.get(originEventId)
          : undefined;
      const requester =
        onBehalfOfRequester({ channel: context.channel, senderId: context.senderId }) ??
        (sourceOrigin && context.senderId?.trim() === sourceOrigin.matrixUserId
          ? { requester_matrix_user_id: sourceOrigin.matrixUserId }
          : undefined);
      const sender = requester && JSON.stringify(requester);
      const slackChannel = /^slack:(?:channel|group):([cg][a-z0-9]+)(?::thread:\d+\.\d+)?$/.exec(
        rest,
      );
      const sourceReply = Boolean(
        requester && "requester_matrix_user_id" in requester && rest.startsWith("slack:"),
      );
      const requiresEvent = requester && ("requester_matrix_user_id" in requester || slackChannel);
      const nativeSender =
        requester &&
        ("requester_matrix_user_id" in requester
          ? requester.requester_matrix_user_id
          : "requester_slack_user_id" in requester
            ? requester.requester_slack_user_id
            : undefined);
      const startedByArrival =
        !requiresEvent ||
        (typeof nativeSender === "string" &&
          origin?.sender?.id === nativeSender &&
          typeof origin?.chat?.eventId === "string" &&
          (sourceReply
            ? arrived?.sourceRooms.get(origin.chat.eventId) === origin.chat.id
            : !slackChannel || origin?.chat?.id?.toLowerCase() === slackChannel[1]) &&
          arrived?.events.has(origin.chat.eventId) === true);
      if (
        sender &&
        arrived?.proven &&
        arrived.at > Date.now() - ARRIVAL_TTL_MS &&
        arrived.senders.size === 1 &&
        arrived.senders.has(sender) &&
        startedByArrival &&
        // Another agent's account is a proven sender but not a person.
        origin?.sender?.isBot !== true
      ) {
        run.sender = sender;
        if (sourceReply && sourceOrigin && typeof origin?.chat?.eventId === "string") {
          const roomId = arrived.sourceRooms.get(origin.chat.eventId);
          if (roomId) {
            run.matrixOrigin = {
              matrixUserId: sourceOrigin.matrixUserId,
              ...(sourceOrigin.accountId ? { accountId: sourceOrigin.accountId } : {}),
              roomId,
              eventId: origin.chat.eventId,
            };
          }
        }
        // Dispatch can queue several native events before the first run starts.
        // Consume only this run's exact event; later runs need their own proof.
        if (requiresEvent && typeof origin?.chat?.eventId === "string") {
          arrived.events.delete(origin.chat.eventId);
          arrived.sourceRooms.delete(origin.chat.eventId);
          arrived.sourceSenders.delete(origin.chat.eventId);
          if (arrived.events.size > 0) {
            remember(arrivals, sessionKey, arrived);
          }
        }
      }
      diagnose({ runId, sessionKey }, run.sender ? "turn-admitted" : "turn-unproven", () => ({
        requesterPresent: Boolean(sender),
        arrivalPresent: Boolean(arrived),
        dispatchProven: arrived?.proven === true,
        arrivalFresh: Boolean(arrived && arrived.at > Date.now() - ARRIVAL_TTL_MS),
        singleSender: arrived?.senders.size === 1,
        senderMatchesArrival: Boolean(sender && arrived?.senders.has(sender)),
        originEventMatches: startedByArrival,
        senderIsBot: origin?.sender?.isBot === true,
      }));
      return undefined;
    },
    { priority: 10_000 },
  );

  /** `sender` is the session's proven or named person; anyone else is unknown. */
  const observe = (sessionKey: string, sender: string, proof?: Proof): void => {
    const now = Date.now();
    let arrived = arrivals.get(sessionKey);
    if (!arrived || arrived.at <= now - ARRIVAL_TTL_MS) {
      // What no run took up in time is forgotten, here and for every other session.
      for (const [key, stale] of arrivals) {
        if (stale.at <= now - ARRIVAL_TTL_MS) {
          arrivals.delete(key);
        }
      }
      arrived = {
        senders: new Set(),
        proven: false,
        events: new Set(),
        sourceRooms: new Map(),
        sourceSenders: new Map(),
        at: now,
      };
    }
    arrived.senders.add(sender);
    arrived.proven ||= proof !== undefined;
    arrived.at = now;
    if (proof?.eventId) {
      arrived.events.add(proof.eventId);
      if (proof.sourceRoomId) {
        arrived.sourceRooms.set(proof.eventId, proof.sourceRoomId);
      }
      if (proof.sourceMatrixUserId) {
        arrived.sourceSenders.set(proof.eventId, {
          matrixUserId: proof.sourceMatrixUserId,
          ...(proof.sourceAccountId ? { accountId: proof.sourceAccountId } : {}),
        });
      }
    }
    remember(arrivals, sessionKey, arrived);
    for (const run of runs.values()) {
      if (run.sessionKey === sessionKey && run.sender !== sender) {
        delete run.sender;
        run.stripSeq = (run.stripSeq ?? 0) + 1;
      }
    }
  };
  const adminSession = (message: Inbound) => {
    const config = configFromRuntime(api);
    const sessionKey = message.sessionKey?.toLowerCase();
    const adminAgentId = /^agent:([^:]+):/.exec(sessionKey ?? "")?.[1];
    return sessionKey && adminAgentId && isAdminAgent(config, adminAgentId)
      ? { adminAgentId, sessionKey }
      : undefined;
  };

  /**
   * A message the host is about to dispatch to the agent. Only here does the
   * channel say whether it proved the sender itself (Slack for its own events,
   * Matrix for the homeserver's), whether the conversation is one person's and
   * which event it is. A Talk consult counts as its attested speaker, unproven;
   * anything else counts as someone unknown.
   */
  const dispatched = (message: Inbound): void => {
    fiUserInbound(message, true);
    const session = adminSession(message);
    if (!session) {
      return;
    }
    const proof =
      message.senderAuthentication === "verified"
        ? provenSender(session.adminAgentId, session.sessionKey, message)
        : undefined;
    observe(
      session.sessionKey,
      proof?.sender ??
        talkConsultSender(session.adminAgentId, session.sessionKey, message) ??
        UNPROVEN,
      proof,
    );
  };

  /**
   * Any input the host accepted for a session, including one injected into a
   * running turn without a dispatch. It proves nobody, and counts against a
   * turn that belongs to somebody else.
   */
  const received = (message: Inbound): void => {
    fiUserInbound(message, false);
    const session = adminSession(message);
    if (!session) {
      return;
    }
    const eventId = message.messageId?.trim();
    const snapshot: Array<[Run, string]> = [];
    const restore = (run: Run, sender: string, seq: number): void => {
      if (
        run.sender === undefined &&
        (run.stripSeq ?? 0) === seq &&
        [...runs.values()].includes(run)
      ) {
        run.sender = sender;
      }
    };
    if (
      eventId &&
      configFromRuntime(api).crossChannelCustody === true &&
      (message.channel === "matrix" || message.channel === "slack")
    ) {
      for (const run of runs.values()) {
        if (
          run.sender !== undefined &&
          run.sessionKey.toLowerCase() === session.sessionKey.toLowerCase()
        ) {
          snapshot.push([run, run.sender]);
        }
      }
    }
    // A retained task's authority does not cover additional injected instructions,
    // even when the injection repeats the original person's asserted sender id.
    for (const run of runs.values()) {
      if (run.continuation && run.sessionKey === session.sessionKey.toLowerCase()) {
        delete run.sender;
        run.stripSeq = (run.stripSeq ?? 0) + 1;
      }
    }
    // Only channel input can be the allowed Matrix person here; a sender id
    // another caller supplies (a hook, a client) still counts as someone else.
    const channelInput = message.channel === "matrix" || message.channel === "slack";
    const requester = channelInput
      ? inboundRequester(session.sessionKey, message)
      : onBehalfOfRequester(message);
    const talk = talkConsultSender(session.adminAgentId, session.sessionKey, message);
    observe(session.sessionKey, talk ?? (requester ? JSON.stringify(requester) : UNPROVEN));
    // The sequence is read after this message's own strip: only a later input changes it.
    const stripped = snapshot
      .filter(([run]) => run.sender === undefined)
      .map(([run, sender]): [Run, string, number] => [run, sender, run.stripSeq ?? 0]);
    if (
      eventId &&
      stripped.length > 0 &&
      queuedBySteerGate.has(`${session.sessionKey}\0${eventId}`)
    ) {
      // The gate already claimed this message: it was never injected.
      for (const [run, sender, seq] of stripped) {
        restore(run, sender, seq);
      }
    } else if (eventId && stripped.length > 0) {
      const key = `${session.sessionKey}\0${eventId}`;
      strippedByArrival.set(key, stripped);
      while (strippedByArrival.size > MAX_TRACKED) {
        strippedByArrival.delete(strippedByArrival.keys().next().value as string);
      }
    }
    if (
      configFromRuntime(api).crossChannelCustody === true &&
      channelInput &&
      requester &&
      !talk &&
      message.channelContext?.sender?.isBot !== true
    ) {
      noticeUnprovenRun(session.sessionKey, message);
    }
  };

  /**
   * A person's input written into a run in this session that cannot act for
   * them (nobody proved it, or this input just took its proof away) is not
   * re-run. The first such person per run is told, in the place the host would
   * reply, to send it again, but only after that run settled and no message run
   * started in the session within NOTICE_GRACE_MS: the host may have queued the
   * input instead of steering it in, and a queued message runs on its own
   * proof. A re-sent message is a new arrival and needs its own proof.
   */
  const noticeUnprovenRun = (sessionKey: string, message: Inbound): void => {
    const eventId = message.messageId?.trim();
    if (eventId && queuedBySteerGate.has(`${sessionKey}\0${eventId}`)) {
      return;
    }
    let target: Run | undefined;
    for (const run of runs.values()) {
      if (run.sessionKey === sessionKey && !run.sender) {
        target = run;
      }
    }
    const channel = message.channel;
    const to = message.conversationId?.trim();
    if (!target || target.notice || !channel || !to) {
      return;
    }
    const threadId = message.threadId;
    const accountId = message.accountId?.trim();
    target.notice = {
      channel,
      to,
      ...(threadId !== undefined && threadId !== "" ? { threadId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(eventId ? { messageId: eventId } : {}),
    };
  };

  /**
   * Whether the host should keep this channel message out of the run that is
   * active in its session and queue it as its own turn (`before_steer`). Only
   * with crossChannelCustody. A message that cannot act through the active run
   * (it proves nobody, or another person than the sender) is not injected: it
   * runs after that run settles, under its own `before_dispatch` proof, with the
   * host's message-id dedupe, so nothing is replayed and no "send it again"
   * notice is needed for it. Answers from memory; an internal fault queues.
   * `queue` is another owner's decision that the message must be queued (the
   * Matrix brief gate): it is then claimed whoever sent it, with the same
   * bookkeeping, so the active run keeps its proof and a refused queue is told.
   */
  const steerGate = (message: Inbound, queue = false): boolean => {
    try {
      if (configFromRuntime(api).crossChannelCustody !== true) {
        return queue;
      }
      const session = adminSession(message);
      if (!session || (message.channel !== "matrix" && message.channel !== "slack")) {
        return queue;
      }
      // A consult stands on its own voice proof: it is never queued.
      if (talkConsultSender(session.adminAgentId, session.sessionKey, message)) {
        return false;
      }
      // Without an event id the host cannot dedupe the queued copy: leave today's path.
      const eventId = message.messageId?.trim();
      if (!eventId) {
        return queue;
      }
      const live = [...runs.values()].filter((run) => run.sessionKey === session.sessionKey);
      if (live.length === 0) {
        return queue;
      }
      const requester = inboundRequester(session.sessionKey, message);
      const incoming = requester ? JSON.stringify(requester) : undefined;
      if (!queue && incoming && live.every((run) => run.sender === incoming)) {
        return false;
      }
      queuedBySteerGate.add(`${session.sessionKey}\0${eventId}`);
      trimSet(queuedBySteerGate, MAX_TRACKED);
      for (const run of live) {
        if (run.notice?.messageId === eventId) {
          delete run.notice;
        }
      }
      // Queued, not injected: the active run keeps the proof its own sender gave it.
      for (const [run, sender, seq] of strippedByArrival.get(`${session.sessionKey}\0${eventId}`) ??
        []) {
        // Skipped when another input was injected in between: it is inside the run now.
        if (
          run.sender === undefined &&
          (run.stripSeq ?? 0) === seq &&
          [...runs.values()].includes(run)
        ) {
          run.sender = sender;
        }
      }
      strippedByArrival.delete(`${session.sessionKey}\0${eventId}`);
      return true;
    } catch {
      return true;
    }
  };
  /**
   * The host could not queue a message `steerGate` claimed (queue cap, drop policy "new"): it
   * runs nowhere, so the person is told to send it again, as for an injected-and-unproven one.
   */
  const steerRefused = (message: Inbound): void => {
    try {
      const session = adminSession(message);
      const eventId = message.messageId?.trim();
      if (!session || !eventId || !queuedBySteerGate.delete(`${session.sessionKey}\0${eventId}`)) {
        return;
      }
      if (
        configFromRuntime(api).crossChannelCustody === true &&
        inboundRequester(session.sessionKey, message)
      ) {
        noticeUnprovenRun(session.sessionKey, message);
      }
    } catch {
      // A notice is best effort.
    }
  };
  const scheduleNotice = (sessionKey: string, route: NoticeRoute): void => {
    const timers = pendingNotices.get(sessionKey) ?? new Set();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (timers.size === 0) {
        pendingNotices.delete(sessionKey);
      }
      void sendNotice(route).catch(() => {
        api.logger.warn("fi-user: injected-input notice not delivered");
      });
    }, NOTICE_GRACE_MS);
    timer.unref?.();
    timers.add(timer);
    pendingNotices.set(sessionKey, timers);
  };
  const sendNotice = async ({ channel, to, threadId, accountId }: NoticeRoute): Promise<void> => {
    const adapter = await api.runtime.channel.outbound.loadAdapter(channel);
    if (!adapter?.sendText) {
      throw new Error("no outbound adapter");
    }
    await adapter.sendText({
      // The adapter contract takes the mutable OpenClawConfig type; it gets a private copy, so
      // nothing it does can change the runtime's own snapshot. Config is plain JSON.
      cfg: JSON.parse(
        JSON.stringify(api.runtime.config?.current?.() ?? api.config),
      ) as OpenClawConfig,
      to,
      text: INJECTED_NOTICE,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(accountId ? { accountId } : {}),
    });
  };

  return {
    dispatched,
    received,
    steerGate,
    steerRefused,
    held,
    decidesAfterMint,
    mint,
    provenToolRequester,
  };
}

export { heldCopy, INJECTED_NOTICE } from "./admin-delegation.shared.js";
