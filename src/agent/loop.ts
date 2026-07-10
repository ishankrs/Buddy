import * as vscode from 'vscode';
import { buildSystemPrompt } from './prompts';
import { SessionMemory } from './memory';
import { getProvider } from '../llm/router';
import type { LLMProvider, Message } from '../llm/types';
import { getToolByName, getToolSchemas } from '../tools/registry';
import type { AgentMode } from './modes';
import { debugLog, showDebugChannel } from './debugLog';
import { ThinkStreamSplitter } from './thinkStream';
import { withAgentRunContext } from './runContext';

export interface AgentRunOptions {
  userMessage: string;
  contextSummary: string;
  mode: AgentMode;
  planMode: boolean;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  memory?: SessionMemory;
  historyMessages?: Message[];
  maxIterationsOverride?: number;
  workerLabel?: string;
  subagentDepth?: number;
}

export interface AgentRunResult {
  assistantText: string;
  messages: Message[];
}

export async function runAgentLoop(
  context: vscode.ExtensionContext,
  options: AgentRunOptions
): Promise<AgentRunResult> {
  const depth = options.subagentDepth ?? 0;
  const allowSpawn = depth === 0 && options.mode !== 'subagent' && options.mode !== 'swarm';

  return withAgentRunContext(
    {
      extensionContext: context,
      stream: options.stream,
      token: options.token,
      contextSummary: options.contextSummary,
      depth,
    },
    () => runAgentLoopInner(context, options, allowSpawn)
  );
}

async function runAgentLoopInner(
  context: vscode.ExtensionContext,
  options: AgentRunOptions,
  allowSpawn: boolean
): Promise<AgentRunResult> {
  const config = vscode.workspace.getConfiguration('buddy');
  const maxIterations =
    options.maxIterationsOverride ?? config.get<number>('maxIterations', 25);
  const autoApproveReadOnly = config.get<boolean>('autoApproveReadOnly', true);
  const debugMode = options.mode === 'debug' || config.get<boolean>('debugVerbose', false);

  if (debugMode) {
    showDebugChannel();
    debugLog(`${options.workerLabel ?? 'Agent'} started`, {
      mode: options.mode,
      userMessage: options.userMessage,
    });
  }

  const provider = await getProvider(context);
  const toolOptions = { includeSpawnSubagent: allowSpawn };
  const tools = getToolSchemas(toolOptions);
  const messages: Message[] = [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: buildSystemPrompt({
            mode: options.mode,
            planMode: options.planMode,
            contextSummary: options.contextSummary,
          }),
        },
      ],
    },
    ...(options.historyMessages ?? []),
    {
      role: 'user',
      content: [{ type: 'text', text: options.userMessage }],
    },
  ];

  const trimmed = options.memory
    ? options.memory.trimMessages(messages)
    : messages.filter((m) => m.role === 'system' || m.role === 'user');
  messages.length = 0;
  messages.push(...trimmed);

  let assistantText = '';
  let iterations = 0;
  const useThinkStream = options.mode === 'think';

  while (iterations < maxIterations) {
    if (options.token.isCancellationRequested) {
      break;
    }

    iterations++;
    const turn = await collectTurn(
      provider,
      messages,
      tools,
      options.token,
      options.stream,
      useThinkStream
    );

    if (turn.text) {
      assistantText += turn.text;
      if (!useThinkStream) {
        options.stream.markdown(turn.text);
      }
    }

    if (turn.toolCalls.length === 0) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: turn.text || '' }],
      });
      break;
    }

    const assistantContent: Message['content'] = [];
    if (turn.text) {
      assistantContent.push({ type: 'text', text: turn.text });
    }
    for (const tc of turn.toolCalls) {
      assistantContent.push({
        type: 'tool_call',
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      });
    }
    messages.push({ role: 'assistant', content: assistantContent });

    for (const tc of turn.toolCalls) {
      if (options.token.isCancellationRequested) {
        break;
      }

      const label = options.workerLabel ? `${options.workerLabel} — ` : '';
      options.stream.progress(`${label}Running tool: \`${tc.name}\``);

      const toolDef = getToolByName(tc.name, toolOptions);
      if (!toolDef) {
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: tc.id,
              name: tc.name,
              content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }),
            },
          ],
        });
        continue;
      }

      if (
        options.planMode &&
        (tc.name === 'edit_file' || tc.name === 'run_terminal')
      ) {
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: tc.id,
              name: tc.name,
              content: JSON.stringify({
                error: 'Plan mode is active — editing and terminal tools are disabled. Provide your plan as text.',
              }),
            },
          ],
        });
        continue;
      }

      if (
        !toolDef.readOnly &&
        !autoApproveReadOnly &&
        toolDef.schema.name !== 'edit_file' &&
        toolDef.schema.name !== 'run_terminal'
      ) {
        const approved = await vscode.window.showInformationMessage(
          `Allow Buddy to run ${tc.name}?`,
          'Allow',
          'Deny'
        );
        if (approved !== 'Allow') {
          messages.push({
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolCallId: tc.id,
                name: tc.name,
                content: JSON.stringify({ error: 'User denied tool execution' }),
              },
            ],
          });
          continue;
        }
      }

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.arguments || '{}');
      } catch {
        args = {};
      }

      if (debugMode) {
        debugLog(`Tool call: ${tc.name}`, args);
      }

      let result: string;
      try {
        result = await toolDef.execute(args);
      } catch (err) {
        result = JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (debugMode) {
        debugLog(`Tool result: ${tc.name}`, truncate(result, 4000));
        options.stream.progress(
          `🔍 \`${tc.name}\` → ${truncate(result.replace(/\s+/g, ' '), 120)}`
        );
      }

      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: tc.id,
            name: tc.name,
            content: result,
          },
        ],
      });
    }

    if (options.planMode && iterations >= 1 && turn.toolCalls.length === 0) {
      break;
    }
  }

  if (iterations >= maxIterations) {
    options.stream.markdown('\n\n*Reached maximum iteration limit.*');
  }

  if (debugMode) {
    debugLog(`${options.workerLabel ?? 'Agent'} finished`, {
      iterations,
      responseLength: assistantText.length,
    });
  }

  return { assistantText, messages };
}

async function collectTurn(
  provider: LLMProvider,
  messages: Message[],
  tools: ReturnType<typeof getToolSchemas>,
  token: vscode.CancellationToken,
  stream: vscode.ChatResponseStream,
  useThinkStream: boolean
): Promise<{
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}> {
  const abortController = new AbortController();
  const listener = token.onCancellationRequested(() => abortController.abort());
  const thinkSplitter = useThinkStream ? new ThinkStreamSplitter() : undefined;

  try {
    let text = '';
    const toolCallMap = new Map<string, { id: string; name: string; arguments: string }>();

    for await (const chunk of provider.chat({
      messages,
      tools,
      signal: abortController.signal,
    })) {
      if (token.isCancellationRequested) {
        break;
      }

      if (chunk.type === 'text') {
        text += chunk.text;
        if (thinkSplitter) {
          thinkSplitter.feed(chunk.text, stream);
        }
      } else if (chunk.type === 'tool_call') {
        toolCallMap.set(chunk.id, {
          id: chunk.id,
          name: chunk.name,
          arguments: chunk.arguments,
        });
      } else if (chunk.type === 'done' && chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          toolCallMap.set(tc.id, tc);
        }
      }
    }

    thinkSplitter?.flush(stream);

    return { text, toolCalls: Array.from(toolCallMap.values()) };
  } finally {
    listener.dispose();
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}
