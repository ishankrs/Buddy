import * as vscode from 'vscode';
import { getAgentRunContext, getMaxSubagentDepth } from '../agent/runContext';
import { runSubagent } from '../agent/subagent';

export async function spawnSubagentTool(args: {
  task: string;
  name?: string;
}): Promise<string> {
  const ctx = getAgentRunContext();
  if (!ctx) {
    return JSON.stringify({
      error: 'Subagent spawn is only available during an active Buddy agent run.',
    });
  }

  const maxDepth = getMaxSubagentDepth();
  if (ctx.depth >= maxDepth) {
    return JSON.stringify({
      error: `Subagent depth limit reached (max ${maxDepth}). Complete the task directly instead.`,
    });
  }

  const task = args.task?.trim();
  if (!task) {
    return JSON.stringify({ error: 'task is required' });
  }

  const name = args.name?.trim() || 'Subagent';

  try {
    const result = await runSubagent(ctx.extensionContext, {
      task,
      name,
      contextSummary: ctx.contextSummary,
      parentStream: ctx.stream,
      token: ctx.token,
      depth: ctx.depth + 1,
    });

    return JSON.stringify({
      status: 'completed',
      name,
      task,
      report: result.assistantText || '(no output)',
    });
  } catch (err) {
    return JSON.stringify({
      status: 'failed',
      name,
      task,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
