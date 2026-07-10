import * as vscode from 'vscode';

export function createWorkerStream(
  parent: vscode.ChatResponseStream,
  workerIndex: number,
  total: number
): vscode.ChatResponseStream {
  const prefix = `Worker ${workerIndex}/${total}`;

  return {
    markdown(value) {
      const text = typeof value === 'string' ? value : value.value;
      if (text.trim()) {
        parent.progress(`**${prefix}:** ${text.slice(0, 200)}`);
      }
    },
    progress(value) {
      parent.progress(`${prefix}: ${value}`);
    },
    reference(value) {
      parent.reference(value);
    },
    button(command) {
      parent.button(command);
    },
    anchor(value, title) {
      parent.anchor(value, title);
    },
    filetree(value, baseUri) {
      parent.filetree(value, baseUri);
    },
    push(part) {
      parent.push(part);
    },
  };
}
