/**
 * Detect natural-language requests to open/spawn a subagent.
 * e.g. "can you open a subagent to write tests for auth.ts"
 */
export function parseSubagentIntent(message: string): { task: string } | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  const patterns = [
    /^(?:@buddy\s+)?(?:can you\s+|could you\s+|please\s+)?(?:open|start|launch|spawn|run|create)\s+(?:a\s+)?sub[- ]?agent\s+(?:to\s+|for\s+)(.+)$/i,
    /^(?:@buddy\s+)?(?:use|with)\s+(?:a\s+)?sub[- ]?agent\s+(?:to\s+|for\s+)(.+)$/i,
    /^(?:@buddy\s+)?delegate\s+(?:(?:this|that)\s+)?(?:to\s+a\s+sub[- ]?agent[:\s]+)?(.+)$/i,
    /^(?:@buddy\s+)?sub[- ]?agent[:\s]+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]?.trim()) {
      return { task: match[1].trim() };
    }
  }

  return null;
}
