import * as vscode from 'vscode';
import { SessionMemory } from '../agent/memory';
import { runFromPanelMessage } from '../agent/runBuddyRequest';
import { resolveMode } from '../agent/modes';
import {
  createThinkingWebviewStream,
  createWebviewResponseStream,
  type WebviewOutboundMessage,
} from '../chat/streamAdapters';
import { applyModelSelection, applyProviderSelection } from '../llm/applyProviderModel';
import { getPanelLlmConfig } from '../llm/panelProviderSettings';
import { selectModelOnly, selectProviderAndModel } from '../llm/selectProviderModel';
import type { ProviderId } from '../llm/router';

type PanelInboundMessage =
  | { type: 'ready' }
  | { type: 'send'; message: string; mode?: string }
  | { type: 'clear' }
  | { type: 'setProvider'; providerId: string }
  | { type: 'setModel'; model: string }
  | { type: 'pickProviderModel' }
  | { type: 'pickModel' };

export class BuddyPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'buddy.panel';

  private view?: vscode.WebviewView;
  private readonly memory: SessionMemory;
  private cancelSource?: vscode.CancellationTokenSource;
  private running = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.memory = new SessionMemory(context);

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('buddy.provider') ||
          event.affectsConfiguration('buddy.model')
        ) {
          this.pushLlmConfig();
        }
      })
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (raw: PanelInboundMessage) => {
      switch (raw.type) {
        case 'ready':
          this.pushLlmConfig();
          break;
        case 'send':
          await this.handleSend(raw.message, raw.mode);
          break;
        case 'clear':
          await this.handleClear();
          break;
        case 'setProvider':
          await applyProviderSelection(this.context, raw.providerId as ProviderId);
          this.pushLlmConfig();
          break;
        case 'setModel':
          await applyModelSelection(raw.model);
          this.pushLlmConfig();
          break;
        case 'pickProviderModel':
          await selectProviderAndModel(this.context);
          this.pushLlmConfig();
          break;
        case 'pickModel':
          await selectModelOnly(this.context);
          this.pushLlmConfig();
          break;
      }
    });
  }

  focus(): void {
    void vscode.commands.executeCommand('buddy.panel.focus');
  }

  private post(msg: WebviewOutboundMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  private pushLlmConfig(): void {
    this.post({ type: 'llmConfig', config: getPanelLlmConfig() });
  }

  private async handleClear(): Promise<void> {
    this.cancelRun();
    await this.memory.clear();
    this.post({ type: 'cleared' });
  }

  private cancelRun(): void {
    this.cancelSource?.cancel();
    this.cancelSource = undefined;
    this.running = false;
  }

  private async handleSend(message: string, modeArg?: string): Promise<void> {
    const text = message.trim();
    if (!text || this.running) {
      return;
    }

    this.cancelRun();
    this.cancelSource = new vscode.CancellationTokenSource();
    this.running = true;

    const mode = resolveMode(modeArg);
    this.post({ type: 'userMessage', text });

    const post = (msg: WebviewOutboundMessage) => this.post(msg);
    const baseStream = createWebviewResponseStream(post);
    const stream =
      mode === 'think'
        ? createThinkingWebviewStream(baseStream, post)
        : baseStream;

    try {
      await runFromPanelMessage(this.context, {
        message: text,
        mode,
        stream,
        token: this.cancelSource.token,
        memory: this.memory,
      });
    } finally {
      this.post({ type: 'assistantDone' });
      this.running = false;
      this.cancelSource = undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel', 'styles.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel', 'main.js')
    );
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Buddy</title>
</head>
<body>
  <header class="header">
    <img class="logo" src="${logoUri}" width="28" height="28" alt="Buddy logo" />
    <div class="header-text">
      <div class="title">Buddy</div>
      <div id="provider-summary" class="subtitle">Loading provider…</div>
    </div>
  </header>

  <div id="messages" class="messages" aria-live="polite"></div>

  <div id="progress" class="progress hidden"></div>

  <footer class="composer">
    <div class="config-row">
      <label for="provider">Provider</label>
      <select id="provider" aria-label="LLM provider"></select>
      <button id="pick-provider-model" type="button" title="Browse providers and models">⋯</button>
    </div>
    <div class="config-row">
      <label for="model">Model</label>
      <select id="model" aria-label="LLM model"></select>
      <button id="pick-model" type="button" title="Choose or enter a custom model">⋯</button>
    </div>
    <div class="mode-row">
      <label for="mode">Mode</label>
      <select id="mode">
        <option value="">Agent</option>
        <option value="think">Think</option>
        <option value="debug">Debug</option>
        <option value="plan">Plan</option>
        <option value="swarm">Swarm</option>
        <option value="subagent">Subagent</option>
      </select>
      <button id="clear" type="button" title="Clear chat">Clear</button>
    </div>
    <div class="input-row">
      <textarea id="input" rows="3" placeholder="Ask Buddy anything about your code…"></textarea>
      <button id="send" type="button">Send</button>
    </div>
  </footer>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export function registerBuddyPanel(
  context: vscode.ExtensionContext
): BuddyPanelProvider {
  const provider = new BuddyPanelProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BuddyPanelProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('buddy.openPanel', () => {
      void vscode.commands.executeCommand('workbench.view.extension.buddy-sidebar');
    })
  );

  return provider;
}
