import * as vscode from 'vscode';
import { formatProviderModelSummary } from './providerConfig';

let statusBarItem: vscode.StatusBarItem | undefined;

export function registerProviderStatusBar(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = 'buddy.selectProviderModel';
  context.subscriptions.push(statusBarItem);

  updateProviderStatusBar();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('buddy.provider') || event.affectsConfiguration('buddy.model')) {
        updateProviderStatusBar();
      }
    })
  );
}

export function updateProviderStatusBar(): void {
  if (!statusBarItem) {
    return;
  }

  statusBarItem.text = `$(hubot) ${formatProviderModelSummary()}`;
  statusBarItem.tooltip = 'Buddy: Click to change LLM provider and model';
  statusBarItem.show();
}
