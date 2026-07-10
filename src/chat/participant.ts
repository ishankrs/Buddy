import * as vscode from 'vscode';
import { runFromChatRequest } from '../agent/runBuddyRequest';
import { SessionMemory } from '../agent/memory';

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
      vscode.window.showInformationMessage('Buddy conversation memory cleared.');
    })
  );
}
