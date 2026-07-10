import * as vscode from 'vscode';

const SECRET_PREFIX = 'buddy.apiKey.';

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
    title: `Buddy: Set ${provider} API Key`,
    prompt: `Enter your ${provider} API key`,
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

export async function configureCustomEndpoint(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('buddy');
  const currentUrl = config.get<string>('baseUrl', '');

  const baseUrl = await promptForBaseUrl(currentUrl);
  if (!baseUrl) {
    return false;
  }

  const apiKey = await vscode.window.showInputBox({
    title: 'Buddy: Set API Key',
    prompt: `Enter the API key for ${baseUrl}`,
    password: true,
    ignoreFocusOut: true,
  });

  if (!apiKey) {
    return false;
  }

  await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  await config.update('provider', 'custom', vscode.ConfigurationTarget.Global);
  await setApiKey(context, 'custom', apiKey);

  const model = config.get<string>('model', '');
  if (!model) {
    const modelName = await vscode.window.showInputBox({
      title: 'Buddy: Set Model Name',
      prompt: 'Enter the model name for this endpoint',
      placeHolder: 'gpt-4o',
      ignoreFocusOut: true,
    });
    if (modelName?.trim()) {
      await config.update('model', modelName.trim(), vscode.ConfigurationTarget.Global);
    }
  }

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
      `No API key configured for ${provider}. Run "Buddy: Set API Key" or "Buddy: Configure API Endpoint (URL + Key)" from the Command Palette.`
    );
  }
  return key;
}
