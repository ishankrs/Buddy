import * as vscode from 'vscode';
import { resolveWorkspacePath } from '../context/gatherer';
import { previewAndApplyEdit } from '../diff/preview';

export async function editFileTool(args: {
  path: string;
  old_string?: string;
  new_string?: string;
  content?: string;
}): Promise<string> {
  const filePath = resolveWorkspacePath(args.path);
  if (!filePath) {
    return JSON.stringify({ error: `Path not in workspace: ${args.path}` });
  }

  const uri = vscode.Uri.file(filePath);
  let originalContent: string;

  try {
    const data = await vscode.workspace.fs.readFile(uri);
    originalContent = Buffer.from(data).toString('utf8');
  } catch {
    originalContent = '';
  }

  let newContent: string;

  if (args.content !== undefined) {
    newContent = args.content;
  } else if (args.old_string !== undefined && args.new_string !== undefined) {
    if (!originalContent.includes(args.old_string)) {
      return JSON.stringify({
        error: 'old_string not found in file',
        path: filePath,
        hint: 'Use read_file first to get the exact content to replace',
      });
    }
    newContent = originalContent.replace(args.old_string, args.new_string);
  } else {
    return JSON.stringify({
      error: 'Provide either content (full write) or old_string + new_string (search/replace)',
    });
  }

  if (newContent === originalContent) {
    return JSON.stringify({ path: filePath, status: 'unchanged', message: 'No changes needed' });
  }

  const applied = await previewAndApplyEdit(uri, originalContent, newContent);

  return JSON.stringify({
    path: filePath,
    status: applied ? 'applied' : 'rejected',
    message: applied
      ? 'Edit applied successfully'
      : 'User rejected the edit',
  });
}

export async function runTerminalTool(args: {
  command: string;
  cwd?: string;
}): Promise<string> {
  const config = vscode.workspace.getConfiguration('buddy');
  const trustedMode = config.get<boolean>('trustedMode', false);

  if (!trustedMode) {
    const choice = await vscode.window.showInformationMessage(
      `Buddy wants to run: ${args.command}`,
      { modal: true },
      'Allow',
      'Deny'
    );
    if (choice !== 'Allow') {
      return JSON.stringify({ status: 'rejected', command: args.command });
    }
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  const cwd = args.cwd
    ? resolveWorkspacePath(args.cwd) ?? folder?.uri.fsPath
    : folder?.uri.fsPath;

  if (!cwd) {
    return JSON.stringify({ error: 'No workspace folder for terminal command' });
  }

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env },
    });

    return JSON.stringify({
      status: 'completed',
      command: args.command,
      cwd,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
      exit_code: 0,
    });
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return JSON.stringify({
      status: 'failed',
      command: args.command,
      cwd,
      stdout: truncateOutput(execErr.stdout ?? ''),
      stderr: truncateOutput(execErr.stderr ?? execErr.message ?? ''),
      exit_code: execErr.code ?? 1,
    });
  }
}

function truncateOutput(text: string, max = 8000): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + `\n... [truncated ${text.length - max} chars]`;
}
