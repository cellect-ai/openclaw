/**
 * Projected text for one Slack message. Slack keeps attachments beside the
 * text, so a file-only message has an empty `text` and a transcript built from
 * text alone shows an empty bubble. Files become linked lines (the link opens
 * the file in Slack, which enforces the viewer's own access); attachment
 * fallback text is used only when the message has no text of its own.
 */
export function slackProjectionContent(message: {
  text?: unknown;
  files?: unknown;
  attachments?: unknown;
}): string {
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const lines: string[] = [];
  if (!text && Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      const fallback = (attachment as { fallback?: unknown; text?: unknown } | null)?.fallback;
      const body =
        typeof fallback === "string" && fallback.trim()
          ? fallback.trim()
          : typeof (attachment as { text?: unknown } | null)?.text === "string"
            ? String((attachment as { text: string }).text).trim()
            : "";
      if (body) {
        lines.push(body);
      }
    }
  }
  if (Array.isArray(message.files)) {
    for (const file of message.files) {
      const { name, title, permalink } = (file ?? {}) as {
        name?: unknown;
        title?: unknown;
        permalink?: unknown;
      };
      const label =
        (typeof name === "string" && name.trim()) || (typeof title === "string" && title.trim());
      if (!label) {
        continue;
      }
      const safe = label.replace(/[[\]()\n\r]/g, " ").slice(0, 200);
      lines.push(
        typeof permalink === "string" && /^https:\/\/[^\s)]+$/.test(permalink)
          ? `📎 [${safe}](${permalink})`
          : `📎 ${safe}`,
      );
    }
  }
  return [text, ...lines].filter(Boolean).join("\n");
}
