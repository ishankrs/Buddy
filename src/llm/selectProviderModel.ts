import * as vscode from 'vscode';
import {
  formatProviderModelSummary,
  getConfiguredModel,
  getConfiguredProviderId,
  getProviderBaseUrl,
  getProviderDefinition,
  PROVIDERS,
  type ProviderDefinition,
} from './providerConfig';
import type { ProviderId } from './router';
import { fetchOpencodeModels, groupOpencodeModels } from './opencodeModels';
import {
  maybeShowOpencodeFreeModelNotice,
  maybeShowOpencodeProviderNotice,
} from './opencodeNotices';
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
    return pickOpencodeModel(context, currentModel);
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
 * Live OpenCode Zen picker: fetches the current catalog from the API (never
 * hardcoded), lists FREE models first with a FREE badge, then paid models.
 */
async function pickOpencodeModel(
  context: vscode.ExtensionContext,
  currentModel: string
): Promise<string | undefined> {
  const current = currentModel.trim();
  let ids: string[];
  try {
    const models = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Buddy: Fetching OpenCode Zen models…',
      },
      async () =>
        fetchOpencodeModels({
          apiKey: await getApiKey(context, 'opencode'),
          baseUrl: getProviderBaseUrl('opencode'),
        })
    );
    ids = models.map((m) => m.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showWarningMessage(
      `Buddy: Could not fetch the live OpenCode Zen model list. ${message}`,
      'Retry',
      'Enter manually'
    );
    if (choice === 'Retry') {
      return pickOpencodeModel(context, currentModel);
    }
    if (choice === 'Enter manually') {
      return promptCustomModel('OpenCode Zen', current || 'kimi-k2.5');
    }
    return undefined;
  }

  if (current && !ids.includes(current)) {
    ids = [current, ...ids];
  }

  const { free, paid } = groupOpencodeModels(ids);
  type Item = vscode.QuickPickItem & { model: string };
  const items: Array<Item | vscode.QuickPickItem> = [
    {
      label: 'FREE — works without paying',
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...free.map((m): Item => ({
      label: m.id,
      description: '$(badge) FREE',
      detail:
        m.id === current
          ? 'Current model · no charge · free/stealth models may use prompts to improve models'
          : 'No charge · free/stealth models may use prompts to improve models',
      picked: m.id === current,
      model: m.id,
    })),
    {
      label: 'Paid — billed by opencode.ai',
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...paid.map((m): Item => ({
      label: m.id,
      description: 'Paid',
      detail:
        m.id === current
          ? 'Current model · billed by opencode.ai'
          : 'Billed by opencode.ai',
      picked: m.id === current,
      model: m.id,
    })),
    {
      label: '$(edit) Enter custom model…',
      description: 'Type any model ID from opencode.ai/docs/zen',
      detail: '',
      model: '',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Buddy: Select Model (OpenCode Zen, live list)',
    placeHolder: current || 'Pick a model — FREE ones need no payment',
  });

  if (!picked || !('model' in picked)) {
    return undefined;
  }

  if (picked.model) {
    return picked.model;
  }

  return promptCustomModel('OpenCode Zen', current);
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
    await maybeShowOpencodeProviderNotice(context);
  }

  const model =
    (await pickModel(context, provider, providerId === currentProvider ? currentModel : '')) ??
    (provider.id === 'custom' ? undefined : provider.defaultModel);

  if (provider.id === 'custom' && !model) {
    vscode.window.showWarningMessage('Custom provider requires a model name.');
    return;
  }

  await config.update('provider', providerId, vscode.ConfigurationTarget.Global);
  if (model) {
    await config.update('model', model, vscode.ConfigurationTarget.Global);
    if (providerId === 'opencode') {
      await maybeShowOpencodeFreeModelNotice(context, model);
    }
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

  if (providerId === 'opencode') {
    await maybeShowOpencodeFreeModelNotice(context, model);
  }

  vscode.window.showInformationMessage(`Buddy: Model set to ${model} (${provider.label})`);
}
