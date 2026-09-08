// Action slash-commands (`/new`, `/models`, …).
//
// Unlike modes (`/plan`, `/think`, … — see modes.ts), actions perform an
// immediate operation instead of shaping an agent run. They work typed in
// both the VS Code chat (`@buddy /new …`) and the sidebar panel input.
//
// Pure module (no `vscode` imports) so it stays unit testable.

export type AgentAction = 'new' | 'models' | 'provider' | 'help';

export interface AgentActionDefinition {
  name: AgentAction;
  description: string;
}

export const AGENT_ACTIONS: AgentActionDefinition[] = [
  {
    name: 'new',
    description: 'Start a fresh conversation (clears memory and the OpenCode session)',
  },
  { name: 'models', description: 'Change the model for the current provider' },
  { name: 'provider', description: 'Change the provider and model' },
  { name: 'help', description: 'List Buddy commands' },
];

export function isAgentAction(name: string): name is AgentAction {
  return AGENT_ACTIONS.some((a) => a.name === name);
}

/**
 * Parse a leading `/action` from message text. Returns the action plus any
 * remaining text (e.g. `/new explain this` → `{ action: 'new', rest: 'explain this' }`).
 * Mode names (`/plan`, …) are NOT actions and return undefined.
 */
export function parseActionCommand(
  text: string
): { action: AgentAction; rest: string } | undefined {
  const match = /^\s*\/([A-Za-z]+)\b\s?([\s\S]*)$/.exec(text);
  if (!match) {
    return undefined;
  }
  const name = match[1].toLowerCase();
  if (!isAgentAction(name)) {
    return undefined;
  }
  return { action: name, rest: (match[2] ?? '').trim() };
}

export function buildHelpMarkdown(): string {
  const lines = [
    '**Buddy commands**',
    '',
    'Modes (chat subcommand or panel dropdown): `/plan` outline first · `/think` reasoned · `/debug` fix-focused · `/swarm` parallel workers · `/subagent` scoped handoff',
    '',
    ...AGENT_ACTIONS.map((a) => `- \`/${a.name}\` — ${a.description}`),
    '',
    'Tip: `/new <message>` starts fresh and immediately sends the message.',
  ];
  return lines.join('\n');
}
