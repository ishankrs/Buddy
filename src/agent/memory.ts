import * as vscode from 'vscode';
import type { Message } from '../llm/types';

const MEMORY_KEY = 'buddy.conversationHistory';

export interface StoredTurn {
  userMessage: string;
  assistantSummary: string;
  messages: Message[];
  timestamp: number;
}

export class SessionMemory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private getKey(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'global';
    return `${MEMORY_KEY}.${hashString(folder)}`;
  }

  async loadTurns(): Promise<StoredTurn[]> {
    const key = this.getKey();
    return this.context.workspaceState.get<StoredTurn[]>(key, []);
  }

  async saveTurn(turn: StoredTurn): Promise<void> {
    const key = this.getKey();
    const turns = await this.loadTurns();
    turns.push(turn);

    const maxTurns = vscode.workspace
      .getConfiguration('buddy')
      .get<number>('maxMemoryTurns', 20);

    while (turns.length > maxTurns) {
      turns.shift();
    }

    await this.context.workspaceState.update(key, turns);
  }

  async clear(): Promise<void> {
    const key = this.getKey();
    await this.context.workspaceState.update(key, undefined);
  }

  trimMessages(messages: Message[], maxChars = 80000): Message[] {
    const system = messages.filter((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');

    let totalChars = system.reduce((sum, m) => sum + messageLength(m), 0);
    const kept: Message[] = [];

    for (let i = rest.length - 1; i >= 0; i--) {
      const len = messageLength(rest[i]);
      if (totalChars + len > maxChars) {
        break;
      }
      kept.unshift(rest[i]);
      totalChars += len;
    }

    return [...system, ...kept];
  }

  flattenHistoryForPrompt(turns: StoredTurn[]): Message[] {
    const messages: Message[] = [];
    for (const turn of turns) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: turn.userMessage }],
      });
      if (turn.assistantSummary) {
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: turn.assistantSummary }],
        });
      }
    }
    return messages;
  }
}

function messageLength(msg: Message): number {
  return msg.content.reduce((sum, c) => {
    if (c.type === 'text') {
      return sum + c.text.length;
    }
    if (c.type === 'tool_result') {
      return sum + c.content.length;
    }
    if (c.type === 'tool_call') {
      return sum + c.arguments.length;
    }
    return sum;
  }, 0);
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
