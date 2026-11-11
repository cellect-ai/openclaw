/**
 * Cellect: a question an ask_user call left unanswered at turn end. A turn
 * that yields while still asking has no answer text; without this its reply
 * was blank (or NO_REPLY) and the person never saw the question.
 */

/** Question tools whose prompt, left unanswered at turn end, is the turn's reply. */
const QUESTION_TOOL_NAMES = new Set(["ask_user", "request_user_input"]);
const MAX_UNRESOLVED_QUESTION_CHARS = 4_000;

/** The question texts of an ask_user / request_user_input call (`questions[].question`). */
export function questionToolTexts(name: string, args: unknown): string[] {
  const questions =
    QUESTION_TOOL_NAMES.has(name) && args && typeof args === "object" && !Array.isArray(args)
      ? (args as { questions?: unknown }).questions
      : undefined;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((entry) =>
      entry &&
      typeof entry === "object" &&
      typeof (entry as { question?: unknown }).question === "string"
        ? (entry as { question: string }).question.trim()
        : "",
    )
    .filter(Boolean);
}

/** The questions of calls that never got a result, joined and bounded. */
export function unresolvedQuestionText(
  questionTextsById: ReadonlyMap<string, readonly string[]>,
  resultIds: ReadonlySet<string>,
): string | undefined {
  const pending = [...questionTextsById]
    .filter(([id]) => !resultIds.has(id))
    .flatMap(([, texts]) => texts);
  if (pending.length === 0) {
    return undefined;
  }
  const text = [...new Set(pending)].join("\n\n");
  return text.length > MAX_UNRESOLVED_QUESTION_CHARS
    ? `${text.slice(0, MAX_UNRESOLVED_QUESTION_CHARS)}…`
    : text;
}
