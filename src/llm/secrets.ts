import * as vscode from 'vscode';

const SECRET_PREFIX = 'buddy.apiKey.';

// API keys are stored ONLY in VS Code SecretStorage (OS keychain) on this
// machine. They are never written to settings files, opencode.json,
// AGENTS.md, or the workspace. Use "Buddy: Set API Key" to store one,
// and "Buddy: Remove API Key" (or re-set with an empty value) to delete it.

export async function getApiKey(
  context: vscode.ExtensionContext,
  provider: string
): Promise<string | undefined> {
  return context.secrets.get(`${SECRET_PREFIX}${provider}`);
}

export async function setApiKey(
  context: vscode.ExtensionContext,
  provider: string,
  key: string
): Promise<void> {
  await context.secrets.store(`${SECRET_PREFIX}${provider}`, key);
}

export async function promptForApiKey(
  context: vscode.ExtensionContext,
  provider: string
): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: `Buddy: Set ${provider} API Key (stored locally only)`,
    prompt: `Enter your ${provider} API key. It is stored only in this machine's VS Code SecretStorage (OS keychain) — never in settings or the workspace.`,
    password: true,
    ignoreFocusOut: true,
  });

  if (key) {
    await setApiKey(context, provider, key);
    return key;
  }
  return undefined;
}

export async function promptForBaseUrl(current?: string): Promise<string | undefined> {
  const baseUrl = await vscode.window.showInputBox({
    title: 'Buddy: Set API Base URL',
    prompt: 'Enter the API base URL (OpenAI-compatible)',
    placeHolder: 'https://api.openai.com/v1',
    value: current,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'Base URL is required';
      }
      try {
        new URL(trimmed);
        return undefined;
      } catch {
        return 'Enter a valid URL (e.g. https://api.example.com/v1)';
      }
    },
  });

  return baseUrl?.trim() || undefined;
}

export async function promptForCustomName(current?: string): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: 'Buddy: Name this custom endpoint',
    prompt: 'Give this endpoint a short, memorable name (e.g. My Proxy, Office LLM)',
    value: current,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'Name is required'),
  });

  return name?.trim() || undefined;
}

export async function configureCustomEndpoint(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('buddy');

  const name = await promptForCustomName(config.get<string>('customName', ''));
  if (!name) {
    return false;
  }

  const currentUrl = config.get<string>('baseUrl', '');
  const baseUrl = await promptForBaseUrl(currentUrl);
  if (!baseUrl) {
    return false;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `Buddy: API Key for ${name}`,
    prompt: `Enter the API key for ${name} (${baseUrl}). Stored locally only, never in settings.`,
    password: true,
    ignoreFocusOut: true,
  });

  if (!apiKey) {
    return false;
  }

  await config.update('customName', name, vscode.ConfigurationTarget.Global);
  await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  await config.update('provider', 'custom', vscode.ConfigurationTarget.Global);
  await setApiKey(context, 'custom', apiKey);

  return true;
}

export async function ensureApiKey(
  context: vscode.ExtensionContext,
  provider: string
): Promise<string> {
  let key = await getApiKey(context, provider);
  if (!key) {
    key = await promptForApiKey(context, provider);
  }
  if (!key) {
    throw new Error(
      `No API key configured for ${provider}. Run "Buddy: Set API Key" or "Buddy: Configure API Endpoint (URL + Key)" from the Command Palette. Keys are stored locally only (VS Code SecretStorage).`
    );
  }
  return key;
}

export async function removeApiKey(
  context: vscode.ExtensionContext,
  provider: string
): Promise<void> {
  await context.secrets.delete(`${SECRET_PREFIX}${provider}`);
}
