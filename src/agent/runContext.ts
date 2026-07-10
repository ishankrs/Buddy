import * as vscode from 'vscode';

export interface AgentRunContext {
  extensionContext: vscode.ExtensionContext;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  contextSummary: string;
  depth: number;
}

let activeContext: AgentRunContext | undefined;

export function setAgentRunContext(ctx: AgentRunContext): void {
  activeContext = ctx;
}

export function clearAgentRunContext(): void {
  activeContext = undefined;
}

export function getAgentRunContext(): AgentRunContext | undefined {
  return activeContext;
}

export async function withAgentRunContext<T>(
  ctx: AgentRunContext,
  fn: () => Promise<T>
): Promise<T> {
  setAgentRunContext(ctx);
  try {
    return await fn();
  } finally {
    clearAgentRunContext();
  }
}

export function getMaxSubagentDepth(): number {
  return vscode.workspace.getConfiguration('buddy').get<number>('maxSubagentDepth', 1);
}
