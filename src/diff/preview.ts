import * as vscode from 'vscode';

export async function previewAndApplyEdit(
  uri: vscode.Uri,
  originalContent: string,
  newContent: string
): Promise<boolean> {
  const fileName = uri.fsPath.split(/[/\\]/).pop() ?? 'file';

  const choice = await vscode.window.showInformationMessage(
    `Buddy wants to edit ${fileName}`,
    { modal: true, detail: 'Review the diff before applying.' },
    'Show Diff',
    'Apply',
    'Reject'
  );

  if (choice === 'Reject' || choice === undefined) {
    return false;
  }

  if (choice === 'Show Diff') {
    await showDiff(uri, originalContent, newContent, fileName);
    const afterDiff = await vscode.window.showInformationMessage(
      `Apply changes to ${fileName}?`,
      { modal: true },
      'Apply',
      'Reject'
    );
    if (afterDiff !== 'Apply') {
      return false;
    }
  }

  return applyEdit(uri, newContent);
}

async function applyEdit(uri: vscode.Uri, newContent: string): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const entireRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );
    edit.replace(uri, entireRange, newContent);
  } catch {
    edit.createFile(uri, { overwrite: true });
    edit.insert(uri, new vscode.Position(0, 0), newContent);
  }

  const success = await vscode.workspace.applyEdit(edit);
  if (success) {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
  return success;
}

async function showDiff(
  uri: vscode.Uri,
  originalContent: string,
  newContent: string,
  title: string
): Promise<void> {
  const originalUri = vscode.Uri.parse(`buddy-original:${uri.fsPath}`);
  const modifiedUri = vscode.Uri.parse(`buddy-modified:${uri.fsPath}`);

  const originalProvider = new SingleContentProvider(originalContent);
  const modifiedProvider = new SingleContentProvider(newContent);

  const originalReg = vscode.workspace.registerTextDocumentContentProvider(
    'buddy-original',
    originalProvider
  );
  const modifiedReg = vscode.workspace.registerTextDocumentContentProvider(
    'buddy-modified',
    modifiedProvider
  );

  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      modifiedUri,
      `${title} (Buddy Preview)`
    );
  } finally {
    setTimeout(() => {
      originalReg.dispose();
      modifiedReg.dispose();
    }, 60_000);
  }
}

class SingleContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly content: string) {}

  provideTextDocumentContent(): string {
    return this.content;
  }
}
