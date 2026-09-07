// Detection of a locally installed OpenCode CLI.
//
// Pure module (no `vscode` imports) so it stays unit testable. All
// OS interaction goes through the injected `ExecDeps`.

export const OPENCODE_INSTALL_DOCS_URL = 'https://opencode.ai/docs';

export interface ExecDeps {
  /** Run a binary with args; resolves stdout on success, rejects otherwise. */
  execFile(path: string, args: string[]): Promise<string>;
  /** True when the path exists (used for well-known install locations). */
  exists(path: string): Promise<boolean>;
  platform: NodeJS.Platform;
  pathEnv: string;
  homeDir: string;
}

export type OpenCodeDetection =
  | { ok: true; path: string; version: string }
  | { ok: false; reason: string };

const VERSION_RE = /(\d+\.\d+\.\d+[^\s]*)/;

/** Well-known install locations beyond PATH (GUI-launched apps have sparse PATH). */
export function candidatePaths(homeDir: string, platform: NodeJS.Platform): string[] {
  const candidates = [
    `${homeDir}/.opencode/bin/opencode`,
    `${homeDir}/.local/bin/opencode`,
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ];
  if (platform === 'win32') {
    candidates.push(`${homeDir}\\AppData\\Local\\Programs\\opencode\\opencode.exe`);
  }
  return candidates;
}

function parseVersion(output: string): string {
  const match = VERSION_RE.exec(output.trim());
  return match ? match[1] : output.trim().slice(0, 40) || 'unknown';
}

/**
 * Resolve a runnable `opencode` executable:
 * 1. explicit custom path (must exist),
 * 2. `opencode` via PATH (`opencode --version` must succeed),
 * 3. well-known install locations.
 */
export async function findOpencodeBinary(
  deps: ExecDeps,
  customPath?: string
): Promise<OpenCodeDetection> {
  const trimmedCustom = (customPath ?? '').trim();
  if (trimmedCustom) {
    if (!(await deps.exists(trimmedCustom))) {
      return {
        ok: false,
        reason: `Configured OpenCode binary was not found at ${trimmedCustom}.`,
      };
    }
    try {
      const out = await deps.execFile(trimmedCustom, ['--version']);
      return { ok: true, path: trimmedCustom, version: parseVersion(out) };
    } catch (err) {
      return {
        ok: false,
        reason: `Configured OpenCode binary at ${trimmedCustom} failed to run (${describeError(err)}).`,
      };
    }
  }

  try {
    const out = await deps.execFile('opencode', ['--version']);
    return { ok: true, path: 'opencode', version: parseVersion(out) };
  } catch {
    // Fall through to well-known locations.
  }

  for (const candidate of candidatePaths(deps.homeDir, deps.platform)) {
    if (!(await deps.exists(candidate))) {
      continue;
    }
    try {
      const out = await deps.execFile(candidate, ['--version']);
      return { ok: true, path: candidate, version: parseVersion(out) };
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    reason:
      'OpenCode CLI was not found on PATH or in the usual install locations.',
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
