import * as vscode from 'vscode';
import type { GatheredContext } from '../context/gatherer';
import { gatherContext, gatherEditorContext } from '../context/gatherer';
import { SessionMemory } from './memory';
import { runAgentLoop } from './loop';
import { runSwarm } from './swarm';
import { runSubagentMode } from './subagent';
import { modeLabel, type AgentMode } from './modes';
export { resolveUserMessageAndMode } from './requestRouting';
import { resolveUserMessageAndMode } from './requestRouting';

export interface BuddyRequestInput {
  userMessage: string;
  mode: AgentMode;
  contextSummary: string;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  memory: SessionMemory;
  historyMessages?: import('../llm/types').Message[];
}

export async function runBuddyRequest(
  context: vscode.ExtensionContext,
  input: BuddyRequestInput
): Promise<void> {
  const planMode = input.mode === 'plan';

  try {
    let result;

    if (input.mode === 'swarm') {
      result = await runSwarm(context, {
        userMessage: input.userMessage,
        contextSummary: input.contextSummary,
        stream: input.stream,
        token: input.token,
        memory: input.memory,
        historyMessages: input.historyMessages,
      });
    } else if (input.mode === 'subagent') {
      result = await runSubagentMode(context, {
        userMessage: input.userMessage,
        contextSummary: input.contextSummary,
        stream: input.stream,
        token: input.token,
      });
    } else {
      result = await runAgentLoop(context, {
        userMessage: input.userMessage,
        contextSummary: input.contextSummary,
        mode: input.mode,
        planMode,
        stream: input.stream,
        token: input.token,
        memory: input.memory,
        historyMessages: input.historyMessages,
        subagentDepth: 0,
      });
    }

    if (!input.token.isCancellationRequested && result.assistantText) {
      await input.memory.saveTurn({
        userMessage: `[${modeLabel(input.mode)}] ${input.userMessage}`,
        assistantSummary: result.assistantText.slice(0, 4000),
        messages: result.messages,
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.stream.markdown(`**Error:** ${message}`);

    if (message.includes('API key')) {
      input.stream.markdown(
        '\n\nRun **Buddy: Configure API Endpoint (URL + Key)** or **Buddy: Set API Key** from the Command Palette.'
      );
    }
  }
}

export async function runFromChatRequest(
  context: vscode.ExtensionContext,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  memory: SessionMemory
): Promise<void> {
  const gathered = await gatherContext(request);
  const { mode, userMessage } = resolveUserMessageAndMode(request.command, request.prompt);

  stream.progress(`Gathering context (${modeLabel(mode)} mode)...`);

  const priorTurns = await memory.loadTurns();
  const historyMessages = memory.flattenHistoryForPrompt(priorTurns);

  await runBuddyRequest(context, {
    userMessage,
    mode,
    contextSummary: gathered.summary,
    stream,
    token,
    memory,
    historyMessages,
  });
}

export async function runFromPanelMessage(
  context: vscode.ExtensionContext,
  options: {
    message: string;
    mode: AgentMode;
    stream: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    memory: SessionMemory;
  }
): Promise<void> {
  const gathered: GatheredContext = await gatherEditorContext();

  let mode = options.mode;
  let userMessage = options.message;
  if (mode === 'default') {
    const resolved = resolveUserMessageAndMode(undefined, options.message);
    mode = resolved.mode;
    userMessage = resolved.userMessage;
  }

  options.stream.progress(`Gathering context (${modeLabel(mode)} mode)...`);

  const priorTurns = await options.memory.loadTurns();
  const historyMessages = options.memory.flattenHistoryForPrompt(priorTurns);

  await runBuddyRequest(context, {
    userMessage,
    mode,
    contextSummary: gathered.summary,
    stream: options.stream,
    token: options.token,
    memory: options.memory,
    historyMessages,
  });
}
