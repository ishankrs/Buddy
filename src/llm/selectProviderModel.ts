import * as vscode from 'vscode';
import {
  formatProviderModelSummary,
  getConfiguredModel,
  getConfiguredProviderId,
  getProviderDefinition,
  PROVIDERS,
  type ProviderDefinition,
} from './providerConfig';
import type { ProviderId } from './router';
import { getSharedManager } from './opencode/manager';
import {
  ensureOpencodeAvailable,
  getWorkspacePath,
  nodeManagerDeps,
} from './opencode/vscode';
import { ensureApiKey, getApiKey, promptForApiKey, promptForBaseUrl } from './secrets';

async function pickProvider(current: ProviderId): Promise<ProviderId | undefined> {
  const picked = await vscode.window.showQuickPick(
    PROVIDERS.map((provider) => ({
      label: provider.label,
      description: provider.description,
      detail: provider.id === current ? 'Current provider' : undefined,
      picked: provider.id === current,
      provider,
    })),
    {
      title: 'Buddy: Select LLM Provider',
      placeHolder: formatProviderModelSummary(),
    }
  );

  return picked?.provider.id;
}

async function promptCustomModel(
  providerLabel: string,
  currentModel: string
): Promise<string | undefined> {
  const custom = await vscode.window.showInputBox({
    title: `Buddy: Custom Model (${providerLabel})`,
    prompt: 'Enter the model name or ID',
    value: currentModel,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Model name is required'),
  });

  return custom?.trim();
}

async function pickModel(
  context: vscode.ExtensionContext,
  provider: ProviderDefinition,
  currentModel: string
): Promise<string | undefined> {
  if (provider.id === 'opencode') {
    return pickOpencodeLocalModel(context, currentModel);
  }

  const items = [
    ...provider.modelSuggestions.map((model) => ({
      label: model,
      description: model === provider.defaultModel ? 'Provider default' : undefined,
      picked: model === currentModel,
      model,
    })),
    {
      label: '$(edit) Enter custom model…',
      description: 'Type any model ID supported by this provider',
      model: '',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Buddy: Select Model (${provider.label})`,
    placeHolder: currentModel || provider.defaultModel || 'Model name',
  });

  if (!picked) {
    return undefined;
  }

  if (picked.model) {
    return picked.model;
  }

  return promptCustomModel(provider.label, currentModel || provider.defaultModel);
}

/**
 * OpenCode (Local) picker: models come from the user's own OpenCode
 * installation via ACP — never hardcoded, no free/paid assumptions.
 * Selecting a model applies it to the local session AND saves buddy.model.
 */
async function pickOpencodeLocalModel(
  context: vscode.ExtensionContext,
  currentModel: string
): Promise<string | undefined> {
  const detection = await ensureOpencodeAvailable(context);
  if (!detection.ok) {
    return undefined;
  }
  const manager = getSharedManager(nodeManagerDeps(context));
  const workspacePath = getWorkspacePath();
  const current = currentModel.trim();

  let listed: { current: string; options: Array<{ value: string; name: string; description?: string }> };
  try {
    listed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Buddy: Reading models from local OpenCode…',
      },
      () => manager.getModelOptions(workspacePath)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showWarningMessage(
      `Buddy: Could not read models from local OpenCode. ${message}`,
      'Retry',
      'Enter manually'
    );
    if (choice === 'Retry') {
      return pickOpencodeLocalModel(context, currentModel);
    }
    if (choice === 'Enter manually') {
      const manual = await promptCustomModel('OpenCode (Local)', current);
      return manual ? applyOpencodeModel(context, workspacePath, manual) : undefined;
    }
    return undefined;
  }

  const effectiveCurrent = current || listed.current;
  type Item = vscode.QuickPickItem & { model: string };
  const items: Item[] = [
    ...listed.options.map((m): Item => ({
      label: m.name || m.value,
      description: m.name && m.name !== m.value ? m.value : undefined,
      detail:
        m.value === effectiveCurrent
          ? current
            ? 'Current model'
            : 'Current model (OpenCode default)'
          : (m.description ?? ''),
      picked: m.value === effectiveCurrent,
      model: m.value,
    })),
    {
      label: '$(edit) Enter custom model…',
      description: 'Type any model ID configured in your OpenCode',
      model: '',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Buddy: Select Model (OpenCode Local${detection.version ? ` v${detection.version}` : ''})`,
    placeHolder: 'Models are provided by your local OpenCode installation',
  });

  if (!picked) {
    return undefined;
  }
  if (!picked.model) {
    const manual = await promptCustomModel('OpenCode (Local)', current);
    return manual ? applyOpencodeModel(context, workspacePath, manual) : undefined;
  }
  return applyOpencodeModel(context, workspacePath, picked.model);
}

/** Apply a model to the local OpenCode session; undefined on failure. */
async function applyOpencodeModel(
  context: vscode.ExtensionContext,
  workspacePath: string,
  value: string
): Promise<string | undefined> {
  try {
    await getSharedManager(nodeManagerDeps(context)).setModel(workspacePath, value);
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(`Buddy: Could not set OpenCode model. ${message}`);
    return undefined;
  }
}

async function ensureProviderReady(
  context: vscode.ExtensionContext,
  provider: ProviderDefinition
): Promise<boolean> {
  if (!provider.requiresApiKey) {
    return true;
  }

  const existing = await getApiKey(context, provider.id);
  if (existing) {
    return true;
  }

  const setKey = await vscode.window.showInformationMessage(
    `No API key stored for ${provider.label}. Set one now?`,
    'Set API Key',
    'Cancel'
  );

  if (setKey !== 'Set API Key') {
    return false;
  }

  const key = await promptForApiKey(context, provider.id);
  return Boolean(key);
}

async function ensureCustomBaseUrl(provider: ProviderDefinition): Promise<boolean> {
  if (provider.id !== 'custom') {
    return true;
  }

  const config = vscode.workspace.getConfiguration('buddy');
  const current = config.get<string>('baseUrl', '').trim();
  if (current) {
    return true;
  }

  const baseUrl = await promptForBaseUrl();
  if (!baseUrl) {
    return false;
  }

  await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  return true;
}

export async function selectProviderAndModel(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('buddy');
  const currentProvider = getConfiguredProviderId();
  const currentModel = getConfiguredModel();

  const providerId = await pickProvider(currentProvider);
  if (!providerId) {
    return;
  }

  const provider = getProviderDefinition(providerId);

  if (!(await ensureCustomBaseUrl(provider))) {
    return;
  }

  if (!(await ensureProviderReady(context, provider))) {
    return;
  }

  if (provider.id === 'opencode') {
    // Local backend: verify the CLI exists (shows install guidance when not).
    // No API keys involved.
    const detection = await ensureOpencodeAvailable(context);
    if (!detection.ok) {
      return;
    }
  }

  const model =
    (await pickModel(context, provider, providerId === currentProvider ? currentModel : '')) ??
    (provider.id === 'custom' ? undefined : provider.defaultModel || undefined);

  if (provider.id === 'custom' && !model) {
    vscode.window.showWarningMessage('Custom provider requires a model name.');
    return;
  }

  await config.update('provider', providerId, vscode.ConfigurationTarget.Global);
  if (model) {
    await config.update('model', model, vscode.ConfigurationTarget.Global);
  }

  const summary = model
    ? `${provider.label} · ${model}`
    : `${provider.label} · ${provider.defaultModel || 'default model'}`;

  vscode.window.showInformationMessage(`Buddy: Using ${summary}`);
}

export async function selectModelOnly(context: vscode.ExtensionContext): Promise<void> {
  const providerId = getConfiguredProviderId();
  const provider = getProviderDefinition(providerId);

  if (provider.id === 'custom' && !(await ensureCustomBaseUrl(provider))) {
    return;
  }

  if (provider.requiresApiKey && !(await ensureProviderReady(context, provider))) {
    return;
  }

  const model = await pickModel(context, provider, getConfiguredModel());
  if (!model) {
    return;
  }

  await vscode.workspace
    .getConfiguration('buddy')
    .update('model', model, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(`Buddy: Model set to ${model} (${provider.label})`);
}
