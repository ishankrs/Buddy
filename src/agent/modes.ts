export type AgentMode = 'default' | 'plan' | 'think' | 'debug' | 'swarm' | 'subagent';

export function resolveMode(command: string | undefined): AgentMode {
  switch (command) {
    case 'plan':
      return 'plan';
    case 'think':
      return 'think';
    case 'debug':
      return 'debug';
    case 'swarm':
      return 'swarm';
    case 'subagent':
      return 'subagent';
    default:
      return 'default';
  }
}

export function modeLabel(mode: AgentMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan';
    case 'think':
      return 'Think';
    case 'debug':
      return 'Debug';
    case 'swarm':
      return 'Swarm';
    case 'subagent':
      return 'Subagent';
    default:
      return 'Agent';
  }
}
