import * as vscode from 'vscode';
import { runFromChatRequest } from '../agent/runBuddyRequest';
import { SessionMemory } from '../agent/memory';
import { getSharedManager } from '../llm/opencode/manager';
import { getWorkspacePath, nodeManagerDeps } from '../llm/opencode/vscode';

export function createChatParticipant(
  context: vscode.ExtensionContext
): vscode.ChatParticipant {
  const memory = new SessionMemory(context);

  const handler: vscode.ChatRequestHandler = async (
    request,
    _chatContext,
    stream,
    token
  ) => {
    await runFromChatRequest(context, request, stream, token, memory);
  };

  const participant = vscode.chat.createChatParticipant('buddy.chat', handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');

  return participant;
}

export function registerClearMemoryCommand(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('buddy.clearMemory', async () => {
      const memory = new SessionMemory(context);
      await memory.clear();
      // Fresh OpenCode session next time (Buddy ↔ OpenCode session mapping).
      try {
        await getSharedManager(nodeManagerDeps(context)).resetSession(getWorkspacePath());
      } catch {
        // Best effort: memory is cleared regardless.
      }
      vscode.window.showInformationMessage('Buddy conversation memory cleared.');
    })
  );
}
