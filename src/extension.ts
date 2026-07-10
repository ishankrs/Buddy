import * as vscode from 'vscode';
import {
  createChatParticipant,
  registerClearMemoryCommand,
} from './chat/participant';
import { configureCustomEndpoint, promptForApiKey, promptForBaseUrl } from './llm/secrets';
import { selectModelOnly, selectProviderAndModel } from './llm/selectProviderModel';
import { PROVIDERS } from './llm/providerCatalog';
import { registerProviderStatusBar } from './llm/statusBar';
import { registerVsCodeTools } from './tools/registry';
import { setWebToolsContext } from './tools/webTools';
import { isChatEnabled, isPanelEnabled, getUiMode, type BuddyUiMode } from './config/uiMode';
import { registerBuddyPanel } from './panel/BuddyPanelProvider';

export function activate(context: vscode.ExtensionContext): void {
  // Register commands first so palette actions work even if later setup fails.
  registerProviderCommands(context);
  registerUiCommands(context);
  registerCoreCommands(context);
  registerProviderStatusBar(context);

  setWebToolsContext(context);

  try {
    registerVsCodeTools(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `Buddy: Could not register VS Code LM tools (${message}). The agent loop still works.`
    );
  }

  registerClearMemoryCommand(context);

  if (isChatEnabled()) {
    const participant = createChatParticipant(context);
    context.subscriptions.push(participant);
  }

  if (isPanelEnabled()) {
    registerBuddyPanel(context);
  }

  maybeShowUiHint(context);
}

function registerProviderCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('buddy.selectProviderModel', async () => {
      await selectProviderAndModel(context);
    }),
    vscode.commands.registerCommand('buddy.selectModel', async () => {
      await selectModelOnly(context);
    }),
    vscode.commands.registerCommand('buddy.openLlmSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:buddy.buddy buddy.provider'
      );
    })
  );
}

function registerCoreCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('buddy.setWebSearchApiKey', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: 'serper',
            description: 'Serper.dev — Google search results (recommended, serper.dev)',
          },
          { label: 'brave', description: 'Brave Search API' },
          { label: 'tavily', description: 'Tavily — agent-focused search' },
          {
            label: 'google',
            description: 'Google Custom Search JSON API (+ set buddy.webSearch.googleCx)',
          },
        ],
        { title: 'Web search provider for API key' }
      );

      if (!picked) {
        return;
      }

      await promptForApiKey(context, picked.label);

      if (picked.label === 'google') {
        const cx = await vscode.window.showInputBox({
          title: 'Google Search Engine ID (cx)',
          prompt: 'From Programmable Search Engine / cse.google.com',
          ignoreFocusOut: true,
        });
        if (cx?.trim()) {
          await vscode.workspace
            .getConfiguration('buddy')
            .update('webSearch.googleCx', cx.trim(), vscode.ConfigurationTarget.Global);
        }
      }

      await vscode.workspace
        .getConfiguration('buddy')
        .update('webSearch.provider', picked.label, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        `Buddy: Web search key saved for ${picked.label}. Provider set to ${picked.label}.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('buddy.configureEndpoint', async () => {
      const ok = await configureCustomEndpoint(context);
      if (ok) {
        vscode.window.showInformationMessage(
          'Buddy: API endpoint configured (custom provider, base URL, and key saved).'
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('buddy.setApiKey', async () => {
      const config = vscode.workspace.getConfiguration('buddy');
      const provider = config.get<string>('provider', 'openai');

      const picked = await vscode.window.showQuickPick(
        PROVIDERS.filter((p) => p.requiresApiKey || p.id === 'ollama').map((p) => ({
          label: p.id,
          description: p.description,
        })),
        { title: 'Select provider for API key' }
      );

      const selected = picked?.label ?? provider;

      if (selected === 'ollama') {
        vscode.window.showInformationMessage(
          'Ollama does not require an API key. Configure the base URL in buddy.ollamaBaseUrl.'
        );
        return;
      }

      if (selected === 'custom') {
        await configureCustomEndpoint(context);
        vscode.window.showInformationMessage('Buddy: Custom endpoint configured.');
        return;
      }

      await promptForApiKey(context, selected);

      const baseUrlKey =
        selected === 'openai'
          ? 'openaiBaseUrl'
          : selected === 'anthropic'
            ? 'anthropicBaseUrl'
            : selected === 'openrouter'
              ? 'openrouterBaseUrl'
              : undefined;

      if (baseUrlKey) {
        const setUrl = await vscode.window.showInformationMessage(
          `Set an optional base URL override for ${selected}?`,
          'Set URL',
          'Skip'
        );
        if (setUrl === 'Set URL') {
          const current = config.get<string>(baseUrlKey, '');
          const baseUrl = await promptForBaseUrl(current);
          if (baseUrl) {
            await config.update(baseUrlKey, baseUrl, vscode.ConfigurationTarget.Global);
          }
        }
      }

      vscode.window.showInformationMessage(`Buddy: API key saved for ${selected}.`);
    })
  );
}

function registerUiCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('buddy.switchUi', async () => {
      const current = getUiMode();
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: 'both',
            description: 'Native @buddy chat + Buddy sidebar panel',
            picked: current === 'both',
          },
          {
            label: 'chat',
            description: 'VS Code Chat only (@buddy)',
            picked: current === 'chat',
          },
          {
            label: 'panel',
            description: 'Buddy sidebar panel only',
            picked: current === 'panel',
          },
        ],
        {
          title: 'Buddy: Choose UI',
          placeHolder: 'Select where Buddy appears',
        }
      );

      if (!picked || picked.label === current) {
        return;
      }

      await vscode.workspace
        .getConfiguration('buddy')
        .update('uiMode', picked.label as BuddyUiMode, vscode.ConfigurationTarget.Global);

      const reload = await vscode.window.showInformationMessage(
        `Buddy UI set to "${picked.label}". Reload to apply.`,
        'Reload Window'
      );
      if (reload === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    })
  );
}

function maybeShowUiHint(context: vscode.ExtensionContext): void {
  const hintKey = 'buddy.uiHintShown';
  if (context.globalState.get(hintKey)) {
    return;
  }

  const mode = getUiMode();
  if (mode === 'both') {
    void context.globalState.update(hintKey, true);
    void vscode.window
      .showInformationMessage(
        'Buddy is ready. Use the sidebar panel or Command Palette → "Buddy: Select Provider and Model".',
        'Open Panel',
        'Select Provider'
      )
      .then((choice) => {
        if (choice === 'Open Panel') {
          void vscode.commands.executeCommand('buddy.openPanel');
        } else if (choice === 'Select Provider') {
          void vscode.commands.executeCommand('buddy.selectProviderModel');
        }
      });
  }
}

export function deactivate(): void {
  // no-op
}
