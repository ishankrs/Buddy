import { PROVIDERS } from './providerCatalog';
import {
  formatProviderModelSummary,
  getConfiguredModel,
  getConfiguredProviderId,
  getProviderDefinition,
} from './providerConfig';
import type { ProviderId } from './router';

export interface PanelLlmConfig {
  providerId: ProviderId;
  providerLabel: string;
  model: string;
  summary: string;
  providers: Array<{ id: ProviderId; label: string }>;
  models: string[];
}

export function getPanelLlmConfig(): PanelLlmConfig {
  const providerId = getConfiguredProviderId();
  const def = getProviderDefinition(providerId);
  const configuredModel = getConfiguredModel();
  const model = configuredModel || def.defaultModel;

  const models = [...def.modelSuggestions];
  if (model && !models.includes(model)) {
    models.unshift(model);
  }

  return {
    providerId,
    providerLabel: def.label,
    model,
    summary: formatProviderModelSummary(),
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
    models,
  };
}
