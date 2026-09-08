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
import {
  getConfiguredProviderId,
} from '../llm/providerConfig';
import {
  getPanelLlmConfig,
  getPanelLlmConfigWithLiveModels,
} from '../llm/panelProviderSettings';
import { getSharedManager } from '../llm/opencode/manager';
import { getWorkspacePath, nodeManagerDeps } from '../llm/opencode/vscode';
import { startFreshConversation } from '../agent/runBuddyRequest';
import { selectModelOnly, selectProviderAndModel } from '../llm/selectProviderModel';
import { searchWorkspaceFiles } from '../context/gatherer';
import type { ProviderId } from '../llm/router';

type PanelInboundMessage =
  | { type: 'ready' }
  | { type: 'send'; message: string; mode?: string }
  | { type: 'cancel' }
  | { type: 'clear' }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'setProvider'; providerId: string }
  | { type: 'setModel'; model: string }
  | { type: 'pickProviderModel' }
  | { type: 'pickModel' }
  | { type: 'searchFiles'; query: string; requestId: number }
  | { type: 'switchSession'; sessionId: string };

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
        case 'cancel':
          this.cancelRun();
          break;
        case 'clear':
          await this.handleClear();
          break;
        case 'deleteSession':
          await this.handleDeleteSession(raw.sessionId);
          break;
        case 'setProvider':
          await applyProviderSelection(this.context, raw.providerId as ProviderId);
          this.pushLlmConfig();
          break;
        case 'setModel':
          await applyModelSelection(raw.model);
          if (getConfiguredProviderId() === 'opencode') {
            // Keep the local session on the picked model (best effort).
            try {
              await getSharedManager(nodeManagerDeps(this.context)).setModel(
                getWorkspacePath(),
                raw.model
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              void vscode.window.showWarningMessage(
                `Buddy: Could not set OpenCode model. ${message}`
              );
            }
          }
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
        case 'searchFiles': {
          const files = await searchWorkspaceFiles(raw.query);
          this.post({ type: 'fileResults', requestId: raw.requestId, files });
          break;
        }
        case 'switchSession':
          await this.handleSwitchSession(raw.sessionId);
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
    const sync = getPanelLlmConfig();
    this.post({ type: 'llmConfig', config: sync });
    if (sync.modelsLoading) {
      void getPanelLlmConfigWithLiveModels(this.context).then((full) => {
        this.post({ type: 'llmConfig', config: full });
      });
    }
  }

  private async handleClear(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'Start a new chat? The current conversation view will be cleared. This cannot be undone.',
      { modal: true },
      'New chat',
      'Cancel'
    );
    if (choice !== 'New chat') {
      // Re-push config so the webview restores the session dropdown selection.
      this.pushLlmConfig();
      return;
    }
    this.cancelRun();
    await startFreshConversation(this.context, this.memory);
    this.post({ type: 'cleared' });
    this.pushLlmConfig();
  }

  /**
   * Permanently delete a previous chat after explicit user confirmation.
   * When the deleted chat is the current one, the view is cleared so the
   * next prompt starts fresh; otherwise the view is left untouched.
   */
  private async handleDeleteSession(sessionId: string): Promise<void> {
    if (!sessionId || sessionId === '__new__') {
      await this.handleClear();
      return;
    }
    const workspacePath = getWorkspacePath();
    const manager = getSharedManager(nodeManagerDeps(this.context));

    let title = 'this chat';
    try {
      const sessions = await manager.listSessions(workspacePath);
      const found = sessions.find((s) => s.sessionId === sessionId);
      if (found?.title?.trim()) {
        const short =
          found.title.trim().length > 60
            ? found.title.trim().slice(0, 59) + '…'
            : found.title.trim();
        title = `"${short}"`;
      }
    } catch {
      // Best effort: fall back to the generic label.
    }

    const isCurrent = manager.currentSessionId(workspacePath) === sessionId;
    const choice = await vscode.window.showWarningMessage(
      isCurrent
        ? `Delete ${title}? It will be permanently removed and the current view cleared. This cannot be undone.`
        : `Delete ${title}? It will be permanently removed from history. This cannot be undone.`,
      { modal: true },
      'Delete',
      'Cancel'
    );
    if (choice !== 'Delete') {
      this.pushLlmConfig();
      return;
    }

    this.cancelRun();
    this.post({ type: 'progress', text: 'Deleting conversation…' });
    try {
      await manager.deleteSession(workspacePath, sessionId);
      if (isCurrent) {
        await this.memory.clear();
        this.post({ type: 'cleared' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', text: `Could not delete that conversation. ${message}` });
    } finally {
      this.post({ type: 'assistantDone' });
      this.pushLlmConfig();
    }
  }

  /**
   * Switch to a previous OpenCode chat: resume it, clear Buddy's own memory
   * (so context matches the resumed session), and replay its history into
   * the view so the user can continue where they left off.
   */
  private async handleSwitchSession(sessionId: string): Promise<void> {
    this.cancelRun();
    const workspacePath = getWorkspacePath();
    const manager = getSharedManager(nodeManagerDeps(this.context));
    this.post({ type: 'progress', text: 'Switching conversation…' });
    try {
      const ok = await manager.useSession(workspacePath, sessionId);
      if (!ok) {
        this.post({ type: 'error', text: 'Could not resume that conversation — it may no longer exist.' });
        this.pushLlmConfig();
        return;
      }
      await this.memory.clear();
      this.post({ type: 'cleared' });
      const items = await manager.loadHistory(workspacePath, sessionId);
      this.post({ type: 'history', items });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', text: `Could not load that conversation. ${message}` });
    } finally {
      this.post({ type: 'assistantDone' });
      this.pushLlmConfig();
    }
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
  <header class="topbar">
    <img class="logo" src="${logoUri}" width="22" height="22" alt="Buddy logo" />
    <div class="title">Buddy</div>
    <div class="status"><span id="status-dot" class="dot"></span><select id="session" class="session-select" aria-label="Conversation"></select><button id="delete-session" class="icon-btn danger" type="button" title="Delete selected chat…">🗑</button><span id="status-text">Loading…</span></div>
  </header>

  <div id="messages" class="messages" aria-live="polite">
    <div id="empty-state" class="empty">
      <div class="empty-title">How can I help?</div>
      <div class="empty-sub">Ask about your code, plan a change,<br/>or hand off a task.<br/>Try <b>/new</b>, <b>/models</b>, or <b>/help</b>.</div>
    </div>
  </div>

  <div id="progress" class="statusline hidden"></div>

  <footer class="composer">
    <div class="composer-card">
      <div id="mention-popup" class="mention-popup hidden"></div>
      <textarea id="input" rows="1" placeholder="Message Buddy…  (type @ to tag files)"></textarea>
      <div class="toolbar">
        <select id="provider" aria-label="LLM provider"></select>
        <button id="model-pill" class="pill" type="button" title="Choose model">◇ Select model</button>
        <select id="mode" aria-label="Agent mode">
          <option value="">Agent</option>
          <option value="think">Think</option>
          <option value="debug">Debug</option>
          <option value="plan">Plan</option>
          <option value="swarm">Swarm</option>
          <option value="subagent">Subagent</option>
        </select>
        <span class="spacer"></span>
        <button id="clear" class="icon-btn" type="button" title="Clear chat">✕</button>
        <button id="send" class="send-btn" type="button" title="Send">↑</button>
      </div>
    </div>
  </footer>
  <div class="hint">Buddy can make mistakes — review diffs before applying.</div>

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
