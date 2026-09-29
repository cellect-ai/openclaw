// Resolves response-prefix templates for channel and sender scoped replies.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export type ResponsePrefixContext = {
  /** Short model name (e.g., "gpt-5.4", "claude-opus-4-6") */
  model?: string;
  /** Full model ID including provider. */
  modelFull?: string;
  /** Provider name (e.g., "openai", "anthropic") */
  provider?: string;
  /** Current thinking level (e.g., "high", "low", "off") */
  thinkingLevel?: string;
  /** Agent identity name */
  identityName?: string;
  /** Channel-native mention for the inbound sender (for example, `<@U123>` on Slack). */
  senderMention?: string;
};

// Regex pattern for template variables: {variableName} or {variable.name}
const TEMPLATE_VAR_PATTERN = /\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;
/** Matches a template variable left in a resolved prefix; such a prefix must not be sent. */
export const UNRESOLVED_RESPONSE_PREFIX_VAR_PATTERN = /\{[a-zA-Z][a-zA-Z0-9.]*\}/;

/** Variable names are case-insensitive; unresolved placeholders remain literal. */
export function resolveResponsePrefixTemplate(
  template: string | undefined,
  context: ResponsePrefixContext,
): string | undefined {
  if (!template) {
    return undefined;
  }

  return template.replace(TEMPLATE_VAR_PATTERN, (match, varName: string) => {
    const normalizedVar = normalizeLowercaseStringOrEmpty(varName);

    switch (normalizedVar) {
      case "model":
        return context.model ?? match;
      case "modelfull":
        return context.modelFull ?? match;
      case "provider":
        return context.provider ?? match;
      case "thinkinglevel":
      case "think":
        return context.thinkingLevel ?? match;
      case "identity.name":
      case "identityname":
        return context.identityName ?? match;
      case "sender.mention":
      case "sendermention":
        return context.senderMention ?? match;
      default:
        return match;
    }
  });
}

/** Strips the provider prefix, date suffix, and trailing -latest tag for display. */
export function extractShortModelName(fullModel: string): string {
  const slash = fullModel.lastIndexOf("/");
  const modelPart = slash >= 0 ? fullModel.slice(slash + 1) : fullModel;

  return modelPart.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}
