import * as vscode from 'vscode';
import * as path from 'path';

export interface GatheredContext {
  workspaceRoot?: string;
  activeFile?: {
    path: string;
    language: string;
    content?: string;
    selection?: string;
    visibleRange?: { start: number; end: number };
  };
  references: Array<{ path: string; content?: string }>;
  diagnostics: Array<{ path: string; message: string; line: number; severity: string }>;
  summary: string;
}

const MAX_CONTEXT_FILE_SIZE = 500 * 1024;

export async function gatherEditorContext(): Promise<GatheredContext> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder?.uri.fsPath;

  const ctx: GatheredContext = {
    references: [],
    diagnostics: [],
    summary: '',
  };

  if (workspaceRoot) {
    ctx.workspaceRoot = workspaceRoot;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.document.isUntitled) {
    const doc = editor.document;
    const filePath = doc.uri.fsPath;
    let content: string | undefined;

    if (doc.getText().length <= MAX_CONTEXT_FILE_SIZE) {
      content = doc.getText();
    }

    const selection = !editor.selection.isEmpty
      ? doc.getText(editor.selection)
      : undefined;

    ctx.activeFile = {
      path: filePath,
      language: doc.languageId,
      content,
      selection,
      visibleRange: {
        start: editor.visibleRanges[0]?.start.line ?? 0,
        end: editor.visibleRanges[0]?.end.line ?? 0,
      },
    };

    const diags = vscode.languages.getDiagnostics(doc.uri);
    for (const d of diags) {
      ctx.diagnostics.push({
        path: filePath,
        message: d.message,
        line: d.range.start.line + 1,
        severity: vscode.DiagnosticSeverity[d.severity] ?? 'Unknown',
      });
    }
  }

  ctx.summary = formatContextSummary(ctx);
  return ctx;
}

export async function gatherContext(
  request: vscode.ChatRequest
): Promise<GatheredContext> {
  const ctx = await gatherEditorContext();

  for (const ref of request.references ?? []) {
    if (ref.value instanceof vscode.Location) {
      const uri = ref.value.uri;
      const content = await readFileSafe(uri);
      ctx.references.push({ path: uri.fsPath, content });
    } else if (ref.value instanceof vscode.Uri) {
      const content = await readFileSafe(ref.value);
      ctx.references.push({ path: ref.value.fsPath, content });
    }
  }

  ctx.summary = formatContextSummary(ctx);
  return ctx;
}

async function readFileSafe(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    if (data.byteLength > MAX_CONTEXT_FILE_SIZE) {
      return `[File too large: ${uri.fsPath}]`;
    }
    return Buffer.from(data).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Find `@path` (or `@"path with spaces"`) tags in a chat message, resolve
 * them against the workspace, and read their contents. Tags that don't
 * resolve to a workspace file are ignored. Used by the panel composer,
 * which has no native file-attach UI.
 */
export async function resolveTaggedFiles(
  message: string
): Promise<Array<{ path: string; content?: string }>> {
  const tags = new Set<string>();
  const re = /@"([^"]+)"|@(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(message)) !== null) {
    const tag = (match[1] ?? match[2] ?? '').trim().replace(/[,.;:!?]+$/, '');
    if (tag) {
      tags.add(tag);
    }
  }

  const results: Array<{ path: string; content?: string }> = [];
  for (const tag of tags) {
    const resolved = resolveWorkspacePath(tag);
    if (!resolved) {
      continue;
    }
    // Skip directories.
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(vscode.Uri.file(resolved));
    } catch {
      continue;
    }
    if (stat.type !== vscode.FileType.File && stat.type !== vscode.FileType.Unknown) {
      continue;
    }
    const content = await readFileSafe(vscode.Uri.file(resolved));
    if (content !== undefined) {
      results.push({ path: resolved, content });
    }
  }
  return results;
}

/** List workspace files matching a query for @-mention completion. */
export async function searchWorkspaceFiles(
  query: string,
  maxResults = 15
): Promise<Array<{ label: string; detail: string; fsPath: string }>> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  const root = folders[0].uri.fsPath;

  // Empty query: offer open editors (most relevant) instead of a glob dump.
  if (!query.trim()) {
    const seen = new Set<string>();
    const out: Array<{ label: string; detail: string; fsPath: string }> = [];
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    for (const tab of tabs) {
      const input = tab.input;
      const uri =
        input instanceof vscode.TabInputText ? input.uri : undefined;
      if (!uri || uri.scheme !== 'file' || seen.has(uri.fsPath)) {
        continue;
      }
      seen.add(uri.fsPath);
      out.push(toFileEntry(root, uri.fsPath));
      if (out.length >= maxResults) {
        break;
      }
    }
    return out;
  }

  const sanitized = query.trim().replace(/[{}[\]*?]/g, '');
  if (!sanitized) {
    return [];
  }
  const pattern = `**/*${sanitized}*`;
  const exclude = '{**/node_modules/**,**/dist/**,**/out/**,**/.git/**,**/.vscode-test/**,**/*.vsix}';
  const uris = await vscode.workspace.findFiles(pattern, exclude, maxResults);
  return uris
    .filter((u) => u.scheme === 'file')
    .map((u) => toFileEntry(root, u.fsPath));
}

function toFileEntry(
  root: string,
  fsPath: string
): { label: string; detail: string; fsPath: string } {
  const rel = path.relative(root, fsPath).replace(/\\/g, '/');
  const label = rel.startsWith('..') ? fsPath : rel;
  const dir = label.includes('/') ? label.slice(0, label.lastIndexOf('/')) : '';
  return { label, detail: dir, fsPath };
}

/** Append file references (e.g. resolved @-tags) and refresh the summary. */
export function addReferences(
  ctx: GatheredContext,
  refs: Array<{ path: string; content?: string }>
): void {
  ctx.references.push(...refs);
  ctx.summary = formatContextSummary(ctx);
}

function formatContextSummary(ctx: GatheredContext): string {
  const parts: string[] = [];

  if (ctx.workspaceRoot) {
    parts.push(`Workspace: ${ctx.workspaceRoot}`);
  }

  if (ctx.activeFile) {
    parts.push(`Active file: ${ctx.activeFile.path} (${ctx.activeFile.language})`);
    if (ctx.activeFile.selection) {
      parts.push(`Selection:\n\`\`\`\n${ctx.activeFile.selection}\n\`\`\``);
    } else if (ctx.activeFile.content) {
      parts.push(`File content:\n\`\`\`${ctx.activeFile.language}\n${ctx.activeFile.content}\n\`\`\``);
    }
  }

  for (const ref of ctx.references) {
    parts.push(`Referenced file: ${ref.path}`);
    if (ref.content) {
      parts.push(`\`\`\`\n${ref.content}\n\`\`\``);
    }
  }

  if (ctx.diagnostics.length > 0) {
    parts.push('Diagnostics:');
    for (const d of ctx.diagnostics) {
      parts.push(`- [${d.severity}] ${d.path}:${d.line} — ${d.message}`);
    }
  }

  return parts.join('\n\n');
}

export function isPathInWorkspace(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return false;
  }
  const normalized = filePath.replace(/\\/g, '/');
  return folders.some((f) => {
    const root = f.uri.fsPath.replace(/\\/g, '/');
    return normalized === root || normalized.startsWith(root + '/');
  });
}

export function resolveWorkspacePath(relativeOrAbsolute: string): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const pathModule = path;
  if (pathModule.isAbsolute(relativeOrAbsolute)) {
    return isPathInWorkspace(relativeOrAbsolute) ? relativeOrAbsolute : undefined;
  }

  const resolved = pathModule.join(folders[0].uri.fsPath, relativeOrAbsolute);
  return isPathInWorkspace(resolved) ? resolved : undefined;
}
