import * as vscode from 'vscode';

export type BuddyUiMode = 'chat' | 'panel' | 'both';

export function getUiMode(): BuddyUiMode {
  return vscode.workspace.getConfiguration('buddy').get<BuddyUiMode>('uiMode', 'both');
}

export function isChatEnabled(): boolean {
  const mode = getUiMode();
  return mode === 'chat' || mode === 'both';
}

export function isPanelEnabled(): boolean {
  const mode = getUiMode();
  return mode === 'panel' || mode === 'both';
}
