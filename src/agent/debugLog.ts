import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getDebugChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Buddy Debug');
  }
  return channel;
}

export function debugLog(message: string, data?: unknown): void {
  const ch = getDebugChannel();
  const line = data !== undefined ? `${message}\n${formatData(data)}` : message;
  ch.appendLine(`[${new Date().toISOString()}] ${line}`);
}

function formatData(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function showDebugChannel(): void {
  getDebugChannel().show(true);
}
