import * as vscode from 'vscode';
import { PROVIDERS } from './providerCatalog';
import {
  formatProviderModelSummary,
  getConfiguredModel,
  getConfiguredProviderId,
  getProviderDefinition,
} from './providerConfig';
import { getSharedManager } from './opencode/manager';
import { OpenCodeError } from './opencode/acp';
import { getWorkspacePath, nodeManagerDeps } from './opencode/vscode';
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
    return {
      ...base,
      models: base.model ? [{ value: base.model, label: base.model }] : [],
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
 * Full config with models from the local OpenCode installation (flat list,
 * exactly as OpenCode advertises them). Falls back to the configured model
 * with `modelsError` when OpenCode is missing or unreachable.
 */
export async function getPanelLlmConfigWithLiveModels(
  context: vscode.ExtensionContext
): Promise<PanelLlmConfig> {
  const base = baseConfig();

  if (base.providerId !== 'opencode') {
    return getPanelLlmConfig();
  }

  try {
    const manager = getSharedManager(nodeManagerDeps(context));
    const listed = await manager.getModelOptions(getWorkspacePath());
    const effectiveCurrent = base.model || listed.current;
    const options: PanelModelOption[] = listed.options.map((m) => ({
      value: m.value,
      label: m.name && m.name !== m.value ? `${m.name} (${m.value})` : m.value,
    }));
    if (effectiveCurrent && !options.some((o) => o.value === effectiveCurrent)) {
      options.unshift({
        value: effectiveCurrent,
        label: effectiveCurrent,
        group: 'Current',
      });
    }
    return { ...base, model: effectiveCurrent, models: options, modelsLoading: false };
  } catch (err) {
    const message =
      err instanceof OpenCodeError && err.kind === 'not-installed'
        ? 'OpenCode CLI not detected — run Buddy: Check OpenCode'
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ...base,
      models: base.model ? [{ value: base.model, label: base.model }] : [],
      modelsLoading: false,
      modelsError: `OpenCode models unavailable (${message})`,
    };
  }
}
