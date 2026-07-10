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

async function pickModel(provider: ProviderDefinition, currentModel: string): Promise<string | undefined> {
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

  const custom = await vscode.window.showInputBox({
    title: `Buddy: Custom Model (${provider.label})`,
    prompt: 'Enter the model name or ID',
    value: currentModel || provider.defaultModel,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Model name is required'),
  });

  return custom?.trim();
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

  const model =
    (await pickModel(provider, providerId === currentProvider ? currentModel : '')) ??
    (provider.id === 'custom' ? undefined : provider.defaultModel);

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

  const model = await pickModel(provider, getConfiguredModel());
  if (!model) {
    return;
  }

  await vscode.workspace
    .getConfiguration('buddy')
    .update('model', model, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(`Buddy: Model set to ${model} (${provider.label})`);
}
