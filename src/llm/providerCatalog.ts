import type { ProviderId } from './router';

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  description: string;
  requiresApiKey: boolean;
  defaultModel: string;
  modelSuggestions: string[];
  baseUrlSettingKey?: string;
  defaultBaseUrl?: string;
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o, o1, and other OpenAI models',
    requiresApiKey: true,
    defaultModel: 'gpt-4o',
    modelSuggestions: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o1', 'o3-mini'],
    baseUrlSettingKey: 'openaiBaseUrl',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models via Anthropic API',
    requiresApiKey: true,
    defaultModel: 'claude-sonnet-4-20250514',
    modelSuggestions: [
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
    ],
    baseUrlSettingKey: 'anthropicBaseUrl',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: '100+ models via openrouter.ai (OpenAI-compatible)',
    requiresApiKey: true,
    defaultModel: 'openai/gpt-4o',
    modelSuggestions: [
      'openai/gpt-4o',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.1-70b-instruct',
      'deepseek/deepseek-chat',
    ],
    baseUrlSettingKey: 'openrouterBaseUrl',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Local models via Ollama',
    requiresApiKey: false,
    defaultModel: 'llama3.1',
    modelSuggestions: ['llama3.1', 'qwen2.5-coder', 'codellama', 'mistral'],
    baseUrlSettingKey: 'ollamaBaseUrl',
    defaultBaseUrl: 'http://localhost:11434',
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Any OpenAI-compatible API (self-hosted, proxy, etc.)',
    requiresApiKey: true,
    defaultModel: '',
    modelSuggestions: [],
    baseUrlSettingKey: 'baseUrl',
  },
];

export function getProviderDefinition(id: ProviderId): ProviderDefinition {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return found;
}
