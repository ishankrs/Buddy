// VS Code glue for the local OpenCode backend: real OS process spawning,
// permission prompts, detection UX, and settings access.
//
// This is the only file under `llm/opencode/` that imports `vscode` (and
// node:child_process). Everything else stays unit testable.

import * as vscode from 'vscode';
import { execFile as execFileCb, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { OPENCODE_INSTALL_DOCS_URL, findOpencodeBinary, type OpenCodeDetection } from './detector';
import type { ManagerDeps, SessionStore } from './manager';
import type { PermissionRequest, SpawnedProcess } from './acp';

export function openOpencodeDocs(): void {
  void vscode.env.openExternal(vscode.Uri.parse(OPENCODE_INSTALL_DOCS_URL));
}

export function getWorkspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

export function getConfiguredBinary(): string {
  return vscode.workspace.getConfiguration('buddy').get<string>('opencodeBinary', '').trim();
}

function execFileAsync(path: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(path, args, { timeout: 15000 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

function spawnProcess(binary: string, args: string[], cwd: string): SpawnedProcess {
  const child = nodeSpawn(binary, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Drain stderr continuously: an un-read pipe can fill up and stall the
  // child process (opencode logs to stderr). Output is discarded — ACP
  // diagnostics travel over stdout as JSON-RPC.
  child.stderr?.on('data', () => undefined);
  child.stderr?.on('error', () => undefined);
  return {
    writeStdin: (data) => {
      child.stdin?.write(data);
    },
    onStdout: (listener) => {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
    },
    onExit: (listener) => {
      child.on('exit', (code) => listener(code));
      child.on('error', () => listener(null));
    },
    kill: (signal) => {
      try {
        child.kill(signal ?? 'SIGTERM');
      } catch {
        // Already gone.
      }
    },
  };
}

/** Production ManagerDeps wired to node + VS Code UI. No API keys involved. */
export function nodeManagerDeps(context: vscode.ExtensionContext): ManagerDeps {
  const store: SessionStore = {
    get: (key) => context.globalState.get<string>(key),
    set: (key, value) => {
      void context.globalState.update(key, value);
    },
    delete: (key) => {
      void context.globalState.update(key, undefined);
    },
  };
  return {
    execDeps: {
      execFile: execFileAsync,
      exists: async (path) => existsSync(path),
      platform: process.platform,
      pathEnv: process.env.PATH ?? '',
      homeDir: os.homedir(),
    },
    spawnDeps: { spawn: spawnProcess },
    store,
    permissionResolver: (request) => vscodePermissionResolver(request),
    logger: () => undefined,
  };
}

/**
 * Map an OpenCode permission request to VS Code UI. Returns the chosen
 * optionId, or undefined to deny. Dismissing the picker denies safely.
 */
export async function vscodePermissionResolver(
  request: PermissionRequest
): Promise<string | undefined> {
  const title = request.toolCall.title || 'a tool';
  const where = request.toolCall.locations?.[0]?.path;
  const detail = where ? `${title} · ${where}` : title;
  const picked = await vscode.window.showQuickPick(
    request.options.map((o) => ({
      label: o.name,
      description: describePermissionKind(o.kind),
      optionId: o.optionId,
    })),
    {
      title: `OpenCode wants to use ${detail}`,
      placeHolder: 'Allow this OpenCode tool call?',
      ignoreFocusOut: true,
    }
  );
  return picked?.optionId;
}

function describePermissionKind(kind: string): string {
  switch (kind) {
    case 'allow_once':
      return 'Allow this once';
    case 'allow_always':
      return 'Always allow';
    case 'reject_once':
      return 'Deny';
    case 'reject_always':
      return 'Always deny';
    default:
      return kind;
  }
}

export function showOpencodeNotInstalled(reason: string): void {
  void vscode.window
    .showWarningMessage(
      `OpenCode is not installed. ${reason} Install OpenCode CLI and configure your account before using OpenCode with Buddy.`,
      'Open Install Docs'
    )
    .then((choice) => {
      if (choice === 'Open Install Docs') {
        openOpencodeDocs();
      }
    });
}

/**
 * Detect OpenCode (honoring `buddy.opencodeBinary`), show guidance when
 * missing, and remove any legacy stored OpenCode credential from the
 * previous direct-API integration. Never asks for or stores API keys.
 */
export async function ensureOpencodeAvailable(
  context: vscode.ExtensionContext
): Promise<OpenCodeDetection> {
  await removeLegacyOpencodeSecret(context);
  const detection = await findOpencodeBinary(
    nodeManagerDeps(context).execDeps,
    getConfiguredBinary()
  );
  if (!detection.ok) {
    showOpencodeNotInstalled(detection.reason);
  }
  return detection;
}

/**
 * Hygiene from the removed direct-API integration: if an OpenCode key was
 * ever stored in SecretStorage, delete it. Buddy must not keep OpenCode
 * credentials.
 */
export async function removeLegacyOpencodeSecret(
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    await context.secrets.delete('buddy.apiKey.opencode');
  } catch {
    // Best effort.
  }
}
