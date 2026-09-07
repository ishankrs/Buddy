import * as vscode from 'vscode';
import * as os from 'node:os';
import { createAnthropicProvider } from './anthropic';
import { createOllamaProvider } from './ollama';
import { createOpenAIProvider } from './openai';
import { createOpencodeLocalProvider } from './opencode/localProvider';
import { getSharedManager } from './opencode/manager';
import { nodeManagerDeps } from './opencode/vscode';
import { getProviderBaseUrl, getProviderDefinition, resolveModelForProvider } from './providerConfig';
import { ensureApiKey } from './secrets';
import type { LLMProvider } from './types';

export type ProviderId = 'openai' | 'anthropic' | 'openrouter' | 'ollama' | 'opencode' | 'custom';

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
  context: vscode.ExtensionContext,
  opts?: { planMode?: boolean }
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
    case 'opencode': {
      // Local OpenCode CLI backend over ACP (stdio). No API keys: auth and
      // models are managed by the user's own OpenCode installation.
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? os.homedir();
      return createOpencodeLocalProvider({
        manager: getSharedManager(nodeManagerDeps(context)),
        workspacePath,
        model,
        planMode: opts?.planMode ?? false,
      });
    }
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
