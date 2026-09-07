import * as vscode from 'vscode';
import { PROVIDERS } from './providerCatalog';
import {
  formatProviderModelSummary,
  getConfiguredModel,
  getConfiguredProviderId,
  getProviderBaseUrl,
  getProviderDefinition,
} from './providerConfig';
import { fetchOpencodeModels } from './opencodeModels';
import { getApiKey } from './secrets';
import type { ProviderId } from './router';

export interface PanelModelOption {
  value: string;
  label: string;
  group?: string;
}

export interface PanelLlmConfig {
  providerId: ProviderId;
  providerLabel: string;
  model: string;
  summary: string;
  providers: Array<{ id: ProviderId; label: string }>;
  models: PanelModelOption[];
  /** True when the opencode dropdown still needs its live list fetched. */
  modelsLoading: boolean;
  modelsError?: string;
}

export const OPENCODE_FREE_GROUP = 'FREE — works without paying';
export const OPENCODE_PAID_GROUP = 'Paid — billed by opencode.ai';

function baseConfig(): Omit<PanelLlmConfig, 'models' | 'modelsLoading' | 'modelsError'> {
  const providerId = getConfiguredProviderId();
  const def = getProviderDefinition(providerId);
  const configuredModel = getConfiguredModel();
  const model = configuredModel || def.defaultModel;

  return {
    providerId,
    providerLabel: def.label,
    model,
    summary: formatProviderModelSummary(),
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
  };
}

/** Instant sync config. For opencode the dropdown is filled in async. */
export function getPanelLlmConfig(): PanelLlmConfig {
  const base = baseConfig();
  const providerId = getConfiguredProviderId();
  const def = getProviderDefinition(providerId);

  if (providerId === 'opencode') {
    const fallback = base.model || def.defaultModel;
    return {
      ...base,
      models: fallback ? [{ value: fallback, label: fallback }] : [],
      modelsLoading: true,
    };
  }

  const models = [...def.modelSuggestions];
  if (base.model && !models.includes(base.model)) {
    models.unshift(base.model);
  }

  return {
    ...base,
    models: models.map((m) => ({ value: m, label: m })),
    modelsLoading: false,
  };
}

/**
 * Full config with the live Zen catalog for the opencode provider
 * (FREE group first with badges, paid group below). Falls back to the
 * configured model with `modelsError` when the fetch fails.
 */
export async function getPanelLlmConfigWithLiveModels(
  context: vscode.ExtensionContext
): Promise<PanelLlmConfig> {
  const base = baseConfig();

  if (base.providerId !== 'opencode') {
    return getPanelLlmConfig();
  }

  try {
    const live = await fetchOpencodeModels({
      apiKey: await getApiKey(context, 'opencode'),
      baseUrl: getProviderBaseUrl('opencode'),
    });
    const options: PanelModelOption[] = live.map((m) => ({
      value: m.id,
      label: m.free ? `${m.id} · FREE` : m.id,
      group: m.free ? OPENCODE_FREE_GROUP : OPENCODE_PAID_GROUP,
    }));
    if (base.model && !options.some((o) => o.value === base.model)) {
      options.unshift({ value: base.model, label: base.model, group: 'Current' });
    }
    return { ...base, models: options, modelsLoading: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback = base.model || getProviderDefinition('opencode').defaultModel;
    return {
      ...base,
      models: fallback ? [{ value: fallback, label: fallback }] : [],
      modelsLoading: false,
      modelsError: `Live model list unavailable (${message}). Use ⋯ to retry.`,
    };
  }
}
