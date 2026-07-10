import * as vscode from 'vscode';
import { buildSystemPrompt } from './prompts';
import { SessionMemory } from './memory';
import { runAgentLoop, type AgentRunResult } from './loop';
import { getProvider } from '../llm/router';
import type { Message } from '../llm/types';
import { createWorkerStream } from '../chat/workerStream';

export interface SwarmResult {
  assistantText: string;
  messages: Message[];
}

export async function runSwarm(
  context: vscode.ExtensionContext,
  options: {
    userMessage: string;
    contextSummary: string;
    stream: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    memory: SessionMemory;
    historyMessages?: Message[];
  }
): Promise<SwarmResult> {
  const config = vscode.workspace.getConfiguration('buddy');
  const workerCount = config.get<number>('swarmWorkers', 3);

  options.stream.markdown(
    `**Swarm mode** — decomposing into up to ${workerCount} parallel workers...\n\n`
  );

  const subtasks = await decomposeTask(context, options, workerCount);
  if (subtasks.length === 0) {
    options.stream.markdown('*Could not decompose task — falling back to single agent.*\n\n');
    const fallback = await runAgentLoop(context, {
      ...options,
      mode: 'default',
      planMode: false,
    });
    return { assistantText: fallback.assistantText, messages: fallback.messages };
  }

  options.stream.markdown(
    `**Subtasks:**\n${subtasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n`
  );

  const workerResults = await Promise.all(
    subtasks.map((subtask, index) =>
      runWorker(context, options, subtask, index + 1, subtasks.length)
    )
  );

  options.stream.markdown('\n---\n**Swarm synthesis**\n\n');

  const synthesis = await synthesizeResults(context, options, subtasks, workerResults);
  options.stream.markdown(synthesis);

  const assistantText = [
    'Swarm results:',
    ...workerResults.map((r, i) => `Worker ${i + 1}: ${r.assistantText}`),
    '',
    'Synthesis:',
    synthesis,
  ].join('\n');

  return {
    assistantText,
    messages: [{ role: 'user', content: [{ type: 'text', text: options.userMessage }] }],
  };
}

async function decomposeTask(
  context: vscode.ExtensionContext,
  options: {
    userMessage: string;
    contextSummary: string;
    token: vscode.CancellationToken;
  },
  workerCount: number
): Promise<string[]> {
  const provider = await getProvider(context);
  const prompt = `Break this coding task into ${workerCount} independent, parallelizable subtasks for specialist agents.

Return ONLY a JSON array of strings, e.g. ["subtask 1", "subtask 2"].
Each subtask should be specific and actionable. No markdown, no explanation.

Task: ${options.userMessage}

Context:
${options.contextSummary}`;

  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ];

  const abortController = new AbortController();
  const listener = options.token.onCancellationRequested(() => abortController.abort());

  let text = '';
  try {
    for await (const chunk of provider.chat({
      messages,
      tools: [],
      signal: abortController.signal,
    })) {
      if (chunk.type === 'text') {
        text += chunk.text;
      }
    }
  } finally {
    listener.dispose();
  }

  return parseSubtasks(text, workerCount);
}

function parseSubtasks(text: string, max: number): string[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .slice(0, max);
      }
    } catch {
      // fall through
    }
  }

  return text
    .split('\n')
    .map((l) => l.replace(/^\d+[\).\s]+/, '').trim())
    .filter((l) => l.length > 10)
    .slice(0, max);
}

async function runWorker(
  context: vscode.ExtensionContext,
  options: {
    userMessage: string;
    contextSummary: string;
    stream: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    memory: SessionMemory;
  },
  subtask: string,
  index: number,
  total: number
): Promise<AgentRunResult> {
  options.stream.markdown(`\n**Worker ${index}/${total}** started: ${subtask}\n`);

  return runAgentLoop(context, {
    userMessage: `Original task: ${options.userMessage}\n\nYour subtask: ${subtask}`,
    contextSummary: options.contextSummary,
    mode: 'swarm',
    planMode: false,
    stream: createWorkerStream(options.stream, index, total),
    token: options.token,
    memory: options.memory,
    maxIterationsOverride: 8,
    workerLabel: `Worker ${index}`,
  });
}

async function synthesizeResults(
  context: vscode.ExtensionContext,
  options: {
    userMessage: string;
    contextSummary: string;
    token: vscode.CancellationToken;
    stream: vscode.ChatResponseStream;
  },
  subtasks: string[],
  results: AgentRunResult[]
): Promise<string> {
  const provider = await getProvider(context);

  const summary = results
    .map((r, i) => `### Worker ${i + 1}: ${subtasks[i]}\n${r.assistantText || '(no output)'}`)
    .join('\n\n');

  const messages: Message[] = [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: buildSystemPrompt({
            mode: 'default',
            planMode: false,
            contextSummary: options.contextSummary,
          }),
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Synthesize these parallel worker results into one cohesive answer for the user.

Original task: ${options.userMessage}

${summary}

Provide: key findings, recommended next steps, and any conflicts between workers.`,
        },
      ],
    },
  ];

  const abortController = new AbortController();
  const listener = options.token.onCancellationRequested(() => abortController.abort());

  let text = '';
  try {
    for await (const chunk of provider.chat({
      messages,
      tools: [],
      signal: abortController.signal,
    })) {
      if (chunk.type === 'text') {
        text += chunk.text;
        options.stream.markdown(chunk.text);
      }
    }
  } finally {
    listener.dispose();
  }

  return text;
}
