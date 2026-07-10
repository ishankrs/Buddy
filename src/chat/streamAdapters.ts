import * as vscode from 'vscode';

export type WebviewOutboundMessage =
  | { type: 'userMessage'; text: string }
  | { type: 'assistantChunk'; text: string }
  | { type: 'assistantThinking'; text: string }
  | { type: 'progress'; text: string }
  | { type: 'assistantDone' }
  | { type: 'error'; text: string }
  | { type: 'cleared' }
  | { type: 'llmConfig'; config: import('../llm/panelProviderSettings').PanelLlmConfig };

export function createWebviewResponseStream(
  post: (msg: WebviewOutboundMessage) => void
): vscode.ChatResponseStream {
  return {
    markdown(value) {
      const text = typeof value === 'string' ? value : value.value;
      if (text) {
        post({ type: 'assistantChunk', text });
      }
    },
    progress(value) {
      post({ type: 'progress', text: value });
    },
    reference(value) {
      const label =
        value instanceof vscode.Location
          ? value.uri.fsPath
          : value.fsPath;
      post({ type: 'progress', text: `📎 ${label}` });
    },
    button(_command) {
      // Buttons not supported in panel UI
    },
    anchor(value, title) {
      const label = title ?? (value instanceof vscode.Location ? value.uri.fsPath : value.fsPath);
      post({ type: 'progress', text: `🔗 ${label}` });
    },
    filetree(_value, _baseUri) {
      // File tree not rendered in panel
    },
    push(_part) {
      // Stream parts not rendered in panel
    },
  };
}

export function createThinkingWebviewStream(
  base: vscode.ChatResponseStream,
  post: (msg: WebviewOutboundMessage) => void
): vscode.ChatResponseStream {
  const OPEN = '<thinking>';
  const CLOSE = '</thinking>';
  let buffer = '';
  let inThinking = false;

  const flushThinking = (text: string) => {
    if (text.trim()) {
      post({ type: 'assistantThinking', text: text.trim() });
    }
  };

  return {
    ...base,
    markdown(value) {
      const chunk = typeof value === 'string' ? value : value.value;
      buffer += chunk;

      while (buffer.length > 0) {
        if (inThinking) {
          const idx = buffer.toLowerCase().indexOf(CLOSE);
          if (idx === -1) {
            flushThinking(buffer);
            buffer = '';
            return;
          }
          flushThinking(buffer.slice(0, idx));
          buffer = buffer.slice(idx + CLOSE.length);
          inThinking = false;
          continue;
        }

        const idx = buffer.toLowerCase().indexOf(OPEN);
        if (idx === -1) {
          if (buffer.includes('<')) {
            const safe = buffer.slice(0, -1);
            buffer = buffer.slice(-1);
            if (safe) {
              base.markdown(safe);
            }
            return;
          }
          base.markdown(buffer);
          buffer = '';
          return;
        }

        const before = buffer.slice(0, idx);
        buffer = buffer.slice(idx + OPEN.length);
        inThinking = true;
        if (before) {
          base.markdown(before);
        }
      }
    },
  };
}
