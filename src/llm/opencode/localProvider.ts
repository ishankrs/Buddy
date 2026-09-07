// Buddy-side adapter over the local OpenCode ACP backend.
//
// Implements Buddy's LLMProvider shape so the existing agent loop, swarm,
// subagent, chat, and panel flows work unchanged: one ACP prompt turn per
// Buddy request. OpenCode runs its own tools internally (Buddy never sees
// tool calls to execute); tool activity is surfaced as progress chunks.
//
// Pure module (no `vscode` imports): workspace path, model, and mode arrive
// as plain arguments.

import type { LLMProvider, Message, StreamChunk, ToolSchema } from '../types';
import type { OpenCodeProcessManager } from './manager';

export interface OpencodeLocalProviderOptions {
  manager: OpenCodeProcessManager;
  workspacePath: string;
  /** Full OpenCode model value (e.g. `opencode/big-pickle`); '' = OpenCode default. */
  model: string;
  planMode: boolean;
}

const PLAN_PREFIX =
  'Plan mode: outline a concrete step-by-step plan only. Do NOT modify files, run commands, or take any actions — respond with the plan as text.';

/** Marker used by Buddy's system prompt (see agent/prompts.ts). */
export const WORKSPACE_CONTEXT_MARKER = '## Current workspace context';

function systemTexts(messages: Message[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.content)
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
}

/**
 * Forward only the workspace-context section of Buddy's system prompt.
 * Buddy's tool/capability instructions describe tools that do not exist in
 * OpenCode, so they are intentionally dropped.
 */
export function extractWorkspaceContext(messages: Message[]): string {
  const system = systemTexts(messages);
  const idx = system.indexOf(WORKSPACE_CONTEXT_MARKER);
  if (idx === -1) {
    return '';
  }
  return system.slice(idx + WORKSPACE_CONTEXT_MARKER.length).trim();
}

function messageText(role: Message['role'], messages: Message[]): string[] {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== role) {
      continue;
    }
    const text = msg.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('')
      .trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts;
}

function lastUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return i;
    }
  }
  return messages.length;
}

/**
 * Compose the ACP prompt. History is included only for fresh sessions (a
 * resumed session already has it); otherwise only the new message plus
 * editor context is sent.
 */
export function buildOpencodePrompt(
  messages: Message[],
  planMode: boolean,
  includeHistory: boolean
): string {
  const sections: string[] = [];
  if (planMode) {
    sections.push(PLAN_PREFIX);
  }
  if (includeHistory) {
    const prior = messages.slice(0, lastUserIndex(messages));
    const priorParts: string[] = [];
    for (const msg of prior) {
      if (msg.role === 'system' || msg.role === 'tool') {
        continue;
      }
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('')
        .trim();
      if (text) {
        priorParts.push(`${msg.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
      }
    }
    if (priorParts.length > 0) {
      sections.push(`Previous conversation (for context):\n${priorParts.join('\n\n')}`);
    }
  }
  const context = extractWorkspaceContext(messages);
  if (context && context !== 'No additional context available.') {
    sections.push(`Workspace context:\n${context}`);
  }
  const current = messageText('user', messages).pop() ?? '';
  sections.push(current || '(empty message)');
  return sections.join('\n\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

export function createOpencodeLocalProvider(
  options: OpencodeLocalProviderOptions
): LLMProvider {
  const { manager, workspacePath, model, planMode } = options;

  return {
    id: 'opencode',
    async *chat(params: {
      messages: Message[];
      tools: ToolSchema[];
      signal: AbortSignal;
    }): AsyncIterable<StreamChunk> {
      // OpenCode uses its own tools/permissions; Buddy tool schemas do not apply.
      void params.tools;
      const { sessionId, created } = await manager.ensureSession(workspacePath);

      const currentModel = model.trim();
      if (currentModel) {
        // Best effort: keep the ACP session on Buddy's selected model.
        try {
          await manager.setModel(workspacePath, currentModel);
        } catch {
          // Fall through and prompt anyway; failures surface clearly there.
        }
      }
      void sessionId;

      const text = buildOpencodePrompt(params.messages, planMode, created);

      const queue: StreamChunk[] = [];
      let done = false;
      let failure: unknown;
      void manager
        .promptOnSession(
          sessionId,
          text,
          {
            onText: (delta) => {
              queue.push({ type: 'text', text: delta });
            },
            onThought: (thought) => {
              queue.push({ type: 'activity', text: `Thinking: ${truncate(thought, 200)}` });
            },
            onTool: (event) => {
              const title = event.title ? ` ${truncate(event.title, 80)}` : '';
              if (event.status === 'pending') {
                queue.push({ type: 'activity', text: `🔧 Running${title}…` });
              } else if (event.status === 'completed') {
                queue.push({ type: 'activity', text: `✓ Done${title}` });
              } else if (event.status === 'failed') {
                queue.push({ type: 'activity', text: `✗ Failed${title}` });
              }
            },
          },
          params.signal
        )
        .then(
          () => {
            done = true;
          },
          (err) => {
            failure = err;
            done = true;
          }
        );

      while (!done || queue.length > 0) {
        const chunk = queue.shift();
        if (chunk) {
          yield chunk;
          continue;
        }
        // Wait briefly for more events without blocking the host.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      if (failure) {
        throw failure;
      }
      yield { type: 'done', stopReason: 'end' };
    },
  };
}
