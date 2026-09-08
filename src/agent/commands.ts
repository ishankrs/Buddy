// Action slash-commands (`/new`, `/models`, `/status`, …).
//
// Unlike modes (`/plan`, `/think`, … — see modes.ts), actions perform an
// immediate operation instead of shaping an agent run. They work typed in
// both the VS Code chat (`@buddy /new …`) and the sidebar panel input.
//
// Pure module (no `vscode` imports) so it stays unit testable. Handlers live
// in actions.ts.

export type AgentAction =
  | 'new'
  | 'models'
  | 'provider'
  | 'help'
  | 'clear'
  | 'model'
  | 'status'
  | 'context'
  | 'doctor'
  | 'compact'
  | 'review'
  | 'diff'
  | 'export'
  | 'init'
  | 'copy'
  | 'btw'
  | 'feedback'
  | 'permissions';

export interface AgentActionDefinition {
  name: AgentAction;
  description: string;
  /** Shown in the `@buddy /…` autocomplete menu. */
  showInMenu: boolean;
}

export const AGENT_ACTIONS: AgentActionDefinition[] = [
  {
    name: 'new',
    description: 'Start a fresh conversation (clears memory and the OpenCode session)',
    showInMenu: true,
  },
  { name: 'models', description: 'Change the model for the current provider', showInMenu: true },
  { name: 'provider', description: 'Change the provider and model', showInMenu: true },
  { name: 'help', description: 'List Buddy commands', showInMenu: true },
  { name: 'clear', description: 'Alias for /new', showInMenu: false },
  { name: 'model', description: 'Alias for /models', showInMenu: false },
  { name: 'status', description: 'Show version, provider, model, and backend status', showInMenu: true },
  { name: 'context', description: 'Show what is filling the conversation context', showInMenu: true },
  { name: 'doctor', description: 'Check the setup (keys, tools, OpenCode) and suggest fixes', showInMenu: true },
  { name: 'compact', description: 'Summarize the conversation to free up context', showInMenu: true },
  { name: 'review', description: 'Review working-tree changes (add "security" for a security focus)', showInMenu: true },
  { name: 'diff', description: 'Show working-tree changes', showInMenu: true },
  { name: 'export', description: 'Save the transcript as a markdown file', showInMenu: true },
  { name: 'init', description: 'Generate a starter AGENTS.md for this repo', showInMenu: true },
  { name: 'copy', description: 'Copy the last response to the clipboard (/copy 2 for earlier)', showInMenu: true },
  { name: 'btw', description: 'Ask a side question without saving it to history', showInMenu: true },
  { name: 'feedback', description: 'Open Buddy’s issue tracker to report a problem', showInMenu: true },
  { name: 'permissions', description: 'View and change tool approval settings', showInMenu: true },
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
  const match = /^\s*\/([A-Za-z-]+)\b\s?([\s\S]*)$/.exec(text);
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
    ...AGENT_ACTIONS.filter((a) => a.showInMenu).map((a) => `- \`/${a.name}\` — ${a.description}`),
    '',
    'Tips: `/new <message>` starts fresh and immediately sends the message. Type `@` in the panel to tag files.',
  ];
  return lines.join('\n');
}
