import * as vscode from 'vscode';
import { getProviderDefinition } from './providerCatalog';
import { getConfiguredModel } from './providerConfig';
import type { ProviderId } from './router';
import { ensureApiKey, getApiKey, promptForApiKey } from './secrets';

export async function applyProviderSelection(
  context: vscode.ExtensionContext,
  providerId: ProviderId
): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('buddy');
  const def = getProviderDefinition(providerId);
  const previousProvider = config.get<ProviderId>('provider', 'openai');
  const previousModel = getConfiguredModel();

  await config.update('provider', providerId, vscode.ConfigurationTarget.Global);

  if (providerId !== previousProvider || !previousModel) {
    if (def.defaultModel) {
      await config.update('model', def.defaultModel, vscode.ConfigurationTarget.Global);
    }
  }

  if (def.requiresApiKey) {
    const existing = await getApiKey(context, providerId);
    if (!existing) {
      const key = await promptForApiKey(context, providerId);
      if (!key) {
        vscode.window.showWarningMessage(
          `${def.label} requires an API key. Run Buddy: Set API Key.`
        );
        return false;
      }
    }
  }

  return true;
}

export async function applyModelSelection(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) {
    return;
  }

  await vscode.workspace
    .getConfiguration('buddy')
    .update('model', trimmed, vscode.ConfigurationTarget.Global);
}

export async function ensureCurrentProviderReady(context: vscode.ExtensionContext): Promise<boolean> {
  const providerId = vscode.workspace.getConfiguration('buddy').get<ProviderId>('provider', 'openai');
  const def = getProviderDefinition(providerId);
  if (!def.requiresApiKey) {
    return true;
  }

  try {
    await ensureApiKey(context, providerId);
    return true;
  } catch {
    return false;
  }
}
