import * as vscode from 'vscode';
import { isFreeOpencodeModel, OPENCODE_ZEN_DOCS_URL } from './opencodeModels';

const PROVIDER_NOTICE_KEY = 'buddy.opencodeProviderNoticeShown';
const FREE_MODEL_NOTICE_KEY = 'buddy.opencodeFreeModelNoticeDismissed';

const PROVIDER_NOTICE =
  'All models here are provided and billed by opencode.ai (OpenCode Zen) — Buddy only forwards your locally stored API key and requests.';

const FREE_MODEL_NOTICE =
  'This is a FREE OpenCode Zen model: it works without paying, but free and stealth models may use your prompts and completions to improve or train models. Avoid sending secrets or private code. Paid Zen models follow their underlying provider retention (e.g. OpenAI/Anthropic ~30 days). Full details: opencode.ai/docs/zen.';

/**
 * One-time info notice that Zen models are all provided by opencode.
 * The acknowledgement flag is stored locally in globalState. Call when
 * the user selects the opencode provider.
 */
export async function maybeShowOpencodeProviderNotice(
  context: vscode.ExtensionContext
): Promise<void> {
  if (context.globalState.get<boolean>(PROVIDER_NOTICE_KEY)) {
    return;
  }
  await context.globalState.update(PROVIDER_NOTICE_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    PROVIDER_NOTICE,
    'Learn more'
  );
  if (choice === 'Learn more') {
    void vscode.env.openExternal(vscode.Uri.parse(OPENCODE_ZEN_DOCS_URL));
  }
}

/**
 * Warning shown when a FREE Zen model is picked: no payment needed, but
 * free/stealth models may collect training data. Dismissable forever via
 * "Don't show again" (stored locally in globalState, never synced).
 */
export async function maybeShowOpencodeFreeModelNotice(
  context: vscode.ExtensionContext,
  modelId: string
): Promise<void> {
  if (!isFreeOpencodeModel(modelId)) {
    return;
  }
  if (context.globalState.get<boolean>(FREE_MODEL_NOTICE_KEY)) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    FREE_MODEL_NOTICE,
    'Learn more',
    "Don't show again"
  );
  if (choice === 'Learn more') {
    void vscode.env.openExternal(vscode.Uri.parse(OPENCODE_ZEN_DOCS_URL));
  } else if (choice === "Don't show again") {
    await context.globalState.update(FREE_MODEL_NOTICE_KEY, true);
  }
}
