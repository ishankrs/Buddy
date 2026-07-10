import * as vscode from 'vscode';
import { runAgentLoop, type AgentRunResult } from './loop';
import { createWorkerStream } from '../chat/workerStream';

export interface SubagentOptions {
  task: string;
  name?: string;
  contextSummary: string;
  parentStream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  depth?: number;
}

export async function runSubagent(
  context: vscode.ExtensionContext,
  options: SubagentOptions
): Promise<AgentRunResult> {
  const config = vscode.workspace.getConfiguration('buddy');
  const maxIterations = config.get<number>('maxSubagentIterations', 12);
  const label = options.name?.trim() || 'Subagent';

  options.parentStream.markdown(`\n**${label}** started…\n`);

  const subStream = createSubagentStream(options.parentStream, label);

  return runAgentLoop(context, {
    userMessage: options.task,
    contextSummary: options.contextSummary,
    mode: 'subagent',
    planMode: false,
    stream: subStream,
    token: options.token,
    maxIterationsOverride: maxIterations,
    workerLabel: label,
    subagentDepth: options.depth ?? 0,
  });
}

function createSubagentStream(
  parent: vscode.ChatResponseStream,
  label: string
): vscode.ChatResponseStream {
  return {
    markdown(value) {
      const text = typeof value === 'string' ? value : value.value;
      if (text.trim()) {
        parent.markdown(text);
      }
    },
    progress(value) {
      parent.progress(`${label}: ${value}`);
    },
    reference(value) {
      parent.reference(value);
    },
    button(command) {
      parent.button(command);
    },
    anchor(value, title) {
      parent.anchor(value, title);
    },
    filetree(value, baseUri) {
      parent.filetree(value, baseUri);
    },
    push(part) {
      parent.push(part);
    },
  };
}

export async function runSubagentMode(
  context: vscode.ExtensionContext,
  options: {
    userMessage: string;
    contextSummary: string;
    stream: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
  }
): Promise<AgentRunResult> {
  options.stream.markdown('**Subagent mode** — spawning a focused agent for this task…\n\n');

  const result = await runSubagent(context, {
    task: options.userMessage,
    name: 'Subagent',
    contextSummary: options.contextSummary,
    parentStream: options.stream,
    token: options.token,
    depth: 0,
  });

  options.stream.markdown(`\n---\n**Subagent finished.**\n\n`);
  return result;
}
