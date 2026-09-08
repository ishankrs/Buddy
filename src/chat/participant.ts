import * as vscode from 'vscode';
import { runFromChatRequest, startFreshConversation } from '../agent/runBuddyRequest';
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
      const choice = await vscode.window.showWarningMessage(
        'Start a new Buddy conversation? The current chat history for this workspace will be cleared. This cannot be undone.',
        { modal: true },
        'New chat',
        'Cancel'
      );
      if (choice !== 'New chat') {
        return;
      }
      const memory = new SessionMemory(context);
      await startFreshConversation(context, memory);
      vscode.window.showInformationMessage('Buddy started a new conversation.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('buddy.deleteSession', async () => {
      const workspacePath = getWorkspacePath();
      let manager: ReturnType<typeof getSharedManager>;
      try {
        manager = getSharedManager(nodeManagerDeps(context));
      } catch {
        vscode.window.showWarningMessage('Buddy: OpenCode backend is not configured.');
        return;
      }
      let sessions: Array<{ sessionId: string; title?: string }>;
      try {
        sessions = await manager.listSessions(workspacePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showWarningMessage(`Buddy: Could not list previous chats. ${message}`);
        return;
      }
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('Buddy: No previous chats to delete.');
        return;
      }
      const current = manager.currentSessionId(workspacePath);
      const picked = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: (s.title?.trim() || 'Untitled chat').slice(0, 80),
          description: s.sessionId === current ? '(current)' : s.sessionId,
          sessionId: s.sessionId,
        })),
        { title: 'Buddy: Delete a previous chat', placeHolder: 'Pick a chat to permanently delete' }
      );
      if (!picked) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete "${picked.label}"? It will be permanently removed from history. This cannot be undone.`,
        { modal: true },
        'Delete',
        'Cancel'
      );
      if (confirm !== 'Delete') {
        return;
      }
      try {
        await manager.deleteSession(workspacePath, picked.sessionId);
        if (picked.sessionId === current) {
          await new SessionMemory(context).clear();
        }
        vscode.window.showInformationMessage(`Buddy deleted "${picked.label}".`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showWarningMessage(`Buddy: Could not delete that chat. ${message}`);
      }
    })
  );
}
