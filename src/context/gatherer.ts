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
