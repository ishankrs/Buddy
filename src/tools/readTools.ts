import * as vscode from 'vscode';
import * as path from 'path';
import { resolveWorkspacePath } from '../context/gatherer';

export const MAX_READ_SIZE = 500 * 1024;

export async function readFileTool(args: {
  path: string;
  start_line?: number;
  end_line?: number;
}): Promise<string> {
  const filePath = resolveWorkspacePath(args.path);
  if (!filePath) {
    return JSON.stringify({ error: `Path not in workspace: ${args.path}` });
  }

  try {
    const uri = vscode.Uri.file(filePath);
    const data = await vscode.workspace.fs.readFile(uri);
    if (data.byteLength > MAX_READ_SIZE) {
      return JSON.stringify({
        error: `File too large (${data.byteLength} bytes). Max ${MAX_READ_SIZE} bytes.`,
        path: filePath,
      });
    }

    const content = Buffer.from(data).toString('utf8');
    const lines = content.split('\n');

    const start = Math.max(1, args.start_line ?? 1);
    const end = Math.min(lines.length, args.end_line ?? lines.length);
    const slice = lines.slice(start - 1, end);

    return JSON.stringify({
      path: filePath,
      start_line: start,
      end_line: end,
      total_lines: lines.length,
      content: slice.map((line, i) => `${start + i}|${line}`).join('\n'),
    });
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      path: filePath,
    });
  }
}

export async function listFilesTool(args: {
  pattern?: string;
  max_results?: number;
}): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return JSON.stringify({ error: 'No workspace folder open' });
  }

  const pattern = args.pattern ?? '**/*';
  const maxResults = args.max_results ?? 100;

  const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}';
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, pattern),
    exclude,
    maxResults
  );

  const relative = files.map((uri) =>
    path.relative(folder.uri.fsPath, uri.fsPath)
  );

  return JSON.stringify({
    count: relative.length,
    files: relative,
  });
}

export async function searchWorkspaceTool(args: {
  query: string;
  file_pattern?: string;
  max_results?: number;
}): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return JSON.stringify({ error: 'No workspace folder open' });
  }

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const maxResults = args.max_results ?? 50;
  const filePattern = args.file_pattern ?? '';

  const rgArgs = [
    '--json',
    '--max-count',
    String(maxResults),
    '--ignore',
    '--glob',
    '!.git',
    '--glob',
    '!node_modules',
    '--glob',
    '!dist',
  ];

  if (filePattern) {
    rgArgs.push('--glob', filePattern);
  }

  rgArgs.push(args.query, folder.uri.fsPath);

  try {
    const { stdout } = await execFileAsync('rg', rgArgs, {
      maxBuffer: 2 * 1024 * 1024,
      cwd: folder.uri.fsPath,
    });

    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          type: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        if (parsed.type === 'match' && parsed.data) {
          matches.push({
            path: parsed.data.path?.text ?? '',
            line: parsed.data.line_number ?? 0,
            text: (parsed.data.lines?.text ?? '').trimEnd(),
          });
        }
      } catch {
        // skip
      }
    }

    return JSON.stringify({ query: args.query, match_count: matches.length, matches });
  } catch (err: unknown) {
    const execErr = err as { code?: number; stdout?: string };
    if (execErr.code === 1) {
      return JSON.stringify({ query: args.query, match_count: 0, matches: [] });
    }

    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      hint: 'Ensure ripgrep (rg) is installed and available in PATH',
    });
  }
}
