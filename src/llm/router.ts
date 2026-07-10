import * as vscode from 'vscode';
import { createAnthropicProvider } from './anthropic';
import { createOllamaProvider } from './ollama';
import { createOpenAIProvider } from './openai';
import { getProviderBaseUrl, getProviderDefinition, resolveModelForProvider } from './providerConfig';
import { ensureApiKey } from './secrets';
import type { LLMProvider } from './types';

export type ProviderId = 'openai' | 'anthropic' | 'openrouter' | 'ollama' | 'custom';

function getOptionalBaseUrl(key: string): string | undefined {
  const value = vscode.workspace.getConfiguration('buddy').get<string>(key, '').trim();
  return value || undefined;
}

function getRequiredBaseUrl(): string {
  const baseUrl = getProviderBaseUrl('custom');
  if (!baseUrl) {
    throw new Error(
      'No base URL configured. Set buddy.baseUrl in Settings or run "Buddy: Configure API Endpoint (URL + Key)".'
    );
  }
  return baseUrl;
}

export async function getProvider(
  context: vscode.ExtensionContext
): Promise<LLMProvider> {
  const config = vscode.workspace.getConfiguration('buddy');
  const providerId = config.get<ProviderId>('provider', 'openai');
  const model = resolveModelForProvider(providerId, config.get<string>('model', ''));

  switch (providerId) {
    case 'openai': {
      const apiKey = await ensureApiKey(context, 'openai');
      return createOpenAIProvider(apiKey, model, {
        baseURL: getOptionalBaseUrl('openaiBaseUrl'),
      });
    }
    case 'anthropic': {
      const apiKey = await ensureApiKey(context, 'anthropic');
      return createAnthropicProvider(apiKey, model, getOptionalBaseUrl('anthropicBaseUrl'));
    }
    case 'openrouter': {
      const apiKey = await ensureApiKey(context, 'openrouter');
      const baseURL = getProviderBaseUrl('openrouter') ?? 'https://openrouter.ai/api/v1';
      return createOpenAIProvider(apiKey, model, {
        baseURL,
        id: 'openrouter',
        defaultModel: getProviderDefinition('openrouter').defaultModel,
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/buddy-vscode',
          'X-Title': 'Buddy VS Code Extension',
        },
      });
    }
    case 'ollama':
      return createOllamaProvider(model);
    case 'custom': {
      const apiKey = await ensureApiKey(context, 'custom');
      const baseURL = getRequiredBaseUrl();
      if (!config.get<string>('model', '').trim()) {
        throw new Error(
          'Custom provider requires buddy.model to be set (e.g. gpt-4o, llama3.1, your-model-name).'
        );
      }
      return createOpenAIProvider(apiKey, model, {
        baseURL,
        id: 'custom',
      });
    }
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}
