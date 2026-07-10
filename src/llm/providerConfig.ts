import * as vscode from 'vscode';
import { getProviderDefinition, PROVIDERS } from './providerCatalog';
import type { ProviderId } from './router';

export { PROVIDERS, getProviderDefinition };
export type { ProviderDefinition } from './providerCatalog';

export function getConfiguredProviderId(): ProviderId {
  return vscode.workspace.getConfiguration('buddy').get<ProviderId>('provider', 'openai');
}

export function getConfiguredModel(): string {
  return vscode.workspace.getConfiguration('buddy').get<string>('model', '').trim();
}

export function resolveModelForProvider(providerId: ProviderId, configuredModel?: string): string {
  const model = (configuredModel ?? getConfiguredModel()).trim();
  if (model) {
    return model;
  }
  return getProviderDefinition(providerId).defaultModel;
}

export function getProviderBaseUrl(providerId: ProviderId): string | undefined {
  const def = getProviderDefinition(providerId);
  const config = vscode.workspace.getConfiguration('buddy');

  if (providerId === 'custom') {
    const baseUrl = config.get<string>('baseUrl', '').trim();
    return baseUrl || undefined;
  }

  if (providerId === 'ollama') {
    return config.get<string>('ollamaBaseUrl', def.defaultBaseUrl ?? 'http://localhost:11434').trim();
  }

  if (def.baseUrlSettingKey) {
    const override = config.get<string>(def.baseUrlSettingKey, '').trim();
    if (override) {
      return override;
    }
  }

  return def.defaultBaseUrl;
}

export function formatProviderModelSummary(): string {
  const providerId = getConfiguredProviderId();
  const def = getProviderDefinition(providerId);
  const model = resolveModelForProvider(providerId);
  return `${def.label} · ${model}`;
}
