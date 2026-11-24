import {
  getUserTurnTranscriptAdmissionOwner,
  readPendingUserTurnTranscriptAdmission,
} from "../../sessions/user-turn-transcript-admission.js";
import type {
  UserTurnTranscriptAdmissionReceipt,
  UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.types.js";
import { AsyncContext } from "../../shared/async-context.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";

export { SessionTranscriptReadFenceError };

const transcriptReadFenceStorage = new AsyncContext<UserTurnTranscriptAdmissionReceipt>(
  Symbol("sessionTranscriptReadFence"),
);

function isSameTranscriptStore(left: string, right: string): boolean {
  return left === right || isSameOpenClawAgentDatabasePath(left, right);
}

type QuestionAnswerScope = {
  recorder: UserTurnTranscriptRecorder | undefined;
  workerOriginal?: UserTurnTranscriptAdmissionReceipt;
  assertActive: () => void;
  inputs: Map<string, UserTurnTranscriptAdmissionReceipt>;
};
const questionAnswerStorage = new AsyncContext<QuestionAnswerScope>(
  Symbol("sessionTranscriptQuestionAnswers"),
);

/** Facts cross the worker boundary; the creator's live authority remains on the host. */
export type SessionTranscriptQuestionAnswerWorkerFacts = Readonly<{
  original: UserTurnTranscriptAdmissionReceipt;
  answers: readonly UserTurnTranscriptAdmissionReceipt[];
}>;

function currentQuestionCreator(scope: QuestionAnswerScope) {
  scope.assertActive();
  if (scope.workerOriginal) {
    return scope.workerOriginal;
  }
  const owner = scope.recorder && getUserTurnTranscriptAdmissionOwner(scope.recorder);
  return owner && !owner.blocked() ? owner.receipt() : undefined;
}

function sameAdmission(
  left: UserTurnTranscriptAdmissionReceipt,
  right: UserTurnTranscriptAdmissionReceipt,
) {
  return (
    left.agentId === right.agentId &&
    left.sessionId === right.sessionId &&
    left.sessionKey === right.sessionKey &&
    isSameTranscriptStore(left.storePath, right.storePath) &&
    left.generation === right.generation &&
    left.entryId === right.entryId &&
    left.rawSeq === right.rawSeq &&
    left.effectiveParentId === right.effectiveParentId &&
    left.activeMessagePosition === right.activeMessagePosition &&
    left.idempotencyKey === right.idempotencyKey &&
    left.logicalTurnId === right.logicalTurnId &&
    left.role === right.role
  );
}

export function captureSessionTranscriptQuestionAnswerWorkerCustody() {
  const scope = questionAnswerStorage.getStore();
  if (!scope || scope.inputs.size === 0) {
    return undefined;
  }
  const original = currentQuestionCreator(scope);
  if (!original) {
    throw new Error("Question transcript creator is no longer active");
  }
  const facts: SessionTranscriptQuestionAnswerWorkerFacts = Object.freeze({
    original: Object.freeze({ ...original }),
    answers: Object.freeze([...scope.inputs.values()].map((input) => Object.freeze({ ...input }))),
  });
  return {
    facts,
    assertCurrent() {
      const current = currentQuestionCreator(scope);
      if (
        !current ||
        !sameAdmission(current, facts.original) ||
        facts.answers.some((answer) => {
          const admitted = scope.inputs.get(answer.entryId);
          return !admitted || !sameAdmission(admitted, answer);
        })
      ) {
        throw new Error("Question transcript creator or answer is no longer active");
      }
    },
  };
}

/** The worker must consult the captured host owner whenever these facts are used. */
export function runWithSessionTranscriptQuestionAnswerWorkerCustody<T>(
  facts: SessionTranscriptQuestionAnswerWorkerFacts,
  assertCurrent: () => void,
  run: () => T,
): T {
  return questionAnswerStorage.run(
    {
      recorder: undefined,
      workerOriginal: facts.original,
      assertActive: assertCurrent,
      inputs: new Map(facts.answers.map((answer) => [answer.entryId, answer])),
    },
    run,
  );
}

/** Answer custody outlives question registration, but never the creator's admitted run. */
export function withSessionTranscriptQuestionAnswers<T>(
  recorder: UserTurnTranscriptRecorder | undefined,
  assertActive: () => void,
  run: (admitAnswer: (source: UserTurnTranscriptRecorder | undefined) => void) => T,
): T {
  const scope: QuestionAnswerScope = { recorder, assertActive, inputs: new Map() };
  return questionAnswerStorage.run(scope, () =>
    run((source) => {
      scope.assertActive();
      const creator = scope.recorder && getUserTurnTranscriptAdmissionOwner(scope.recorder);
      const original = creator?.receipt();
      const input = readPendingUserTurnTranscriptAdmission(source);
      if (
        original &&
        input &&
        !creator?.blocked() &&
        input.agentId === original.agentId &&
        input.sessionId === original.sessionId &&
        input.sessionKey === original.sessionKey &&
        isSameTranscriptStore(input.storePath, original.storePath) &&
        input.generation === original.generation
      ) {
        scope.inputs.set(input.entryId, input);
      }
    }),
  );
}

export function captureSessionTranscriptQuestionAnswers(
  database: Pick<OpenClawAgentDatabase, "path">,
  sessionId: string,
  admittedUserId?: string,
) {
  const scope = questionAnswerStorage.getStore();
  const answers = [...(scope?.inputs.values() ?? [])].filter(
    (input) =>
      isSameTranscriptStore(input.storePath, database.path) && input.sessionId === sessionId,
  );
  if (!scope || answers.length === 0) {
    return undefined;
  }
  const assertCurrent = () => {
    scope.assertActive();
    const original = currentQuestionCreator(scope);
    if (
      !original ||
      !answers.every(
        (input) =>
          original.agentId === input.agentId &&
          original.sessionId === input.sessionId &&
          original.sessionKey === input.sessionKey &&
          isSameTranscriptStore(original.storePath, input.storePath) &&
          original.generation === input.generation &&
          (admittedUserId === undefined || original.entryId === admittedUserId),
      )
    ) {
      throw new SqliteTranscriptMutationConflictError(sessionId);
    }
  };
  assertCurrent();
  return { answers, assertCurrent };
}

type SessionTranscriptReadFence = Readonly<{
  admission: UserTurnTranscriptAdmissionReceipt;
  beforeActiveMessagePosition: number;
  beforeRawSeq: number;
}>;

export function runWithSessionTranscriptReadFence<T>(
  receipt: UserTurnTranscriptAdmissionReceipt | undefined,
  run: () => T,
): T {
  return receipt ? transcriptReadFenceStorage.run(receipt, run) : run();
}

export function withoutSessionTranscriptReadFence<T>(run: () => T): T {
  return transcriptReadFenceStorage.exit(run);
}

export function withSessionContextAdmission<T>(
  target: SessionTranscriptRuntimeTarget,
  admission: UserTurnTranscriptAdmissionReceipt | undefined,
  read: () => T,
): T {
  if (
    admission &&
    (target.agentId !== admission.agentId ||
      target.sessionId !== admission.sessionId ||
      target.sessionKey !== admission.sessionKey)
  ) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different transcript target",
    );
  }
  return runWithSessionTranscriptReadFence(admission, read);
}

export function resolveSessionTranscriptReadFence(session: {
  agentId: string;
  sessionId: string;
}): UserTurnTranscriptAdmissionReceipt | undefined {
  const receipt = transcriptReadFenceStorage.getStore();
  return receipt?.agentId === session.agentId && receipt.sessionId === session.sessionId
    ? receipt
    : undefined;
}

export function resolveSqliteSessionTranscriptReadFence(params: {
  database: Pick<OpenClawAgentDatabase, "path">;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
}): SessionTranscriptReadFence | undefined {
  const receipt = resolveSessionTranscriptReadFence(params);
  if (!receipt) {
    return undefined;
  }
  if (receipt.role !== "user") {
    throw new SessionTranscriptReadFenceError(
      `Current-turn transcript admission is not a user message: ${receipt.entryId}`,
    );
  }
  if (!isSameTranscriptStore(params.database.path, receipt.storePath)) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different transcript store",
    );
  }
  if (params.sessionKey !== undefined && params.sessionKey !== receipt.sessionKey) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different session key",
    );
  }
  // The admission owner publishes these committed bounds. Context consumers
  // validate their accepted snapshot; external SQLite writers are unsupported.
  return {
    admission: receipt,
    beforeActiveMessagePosition: receipt.activeMessagePosition,
    beforeRawSeq: receipt.rawSeq,
  };
}
