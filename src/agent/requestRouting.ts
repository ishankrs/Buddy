import { parseSubagentIntent } from './subagentIntent';
import { resolveMode, type AgentMode } from './modes';

export function resolveUserMessageAndMode(
  command: string | undefined,
  prompt: string
): { mode: AgentMode; userMessage: string } {
  let mode = resolveMode(command);
  let userMessage = prompt;

  if (mode === 'default') {
    const intent = parseSubagentIntent(prompt);
    if (intent) {
      mode = 'subagent';
      userMessage = intent.task;
    }
  }

  return { mode, userMessage };
}
