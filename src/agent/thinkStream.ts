import * as vscode from 'vscode';

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';

export class ThinkStreamSplitter {
  private buffer = '';
  private inThinking = false;

  feed(chunk: string, stream: vscode.ChatResponseStream): void {
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (this.inThinking) {
        const closeIdx = this.buffer.toLowerCase().indexOf(CLOSE_TAG);
        if (closeIdx === -1) {
          const partial = this.buffer;
          this.buffer = '';
          if (partial.trim()) {
            stream.progress(`💭 ${partial.trim()}`);
          }
          return;
        }

        const thinking = this.buffer.slice(0, closeIdx);
        this.buffer = this.buffer.slice(closeIdx + CLOSE_TAG.length);
        this.inThinking = false;

        if (thinking.trim()) {
          stream.markdown(
            `\n<details><summary>💭 Thinking</summary>\n\n${thinking.trim()}\n\n</details>\n\n`
          );
        }
        continue;
      }

      const openIdx = this.buffer.toLowerCase().indexOf(OPEN_TAG);
      if (openIdx === -1) {
        if (this.buffer.includes('<')) {
          const safe = this.buffer.slice(0, -1);
          this.buffer = this.buffer.slice(-1);
          if (safe) {
            stream.markdown(safe);
          }
          return;
        }
        stream.markdown(this.buffer);
        this.buffer = '';
        return;
      }

      const before = this.buffer.slice(0, openIdx);
      this.buffer = this.buffer.slice(openIdx + OPEN_TAG.length);
      this.inThinking = true;
      if (before) {
        stream.markdown(before);
      }
    }
  }

  flush(stream: vscode.ChatResponseStream): void {
    if (!this.buffer) {
      return;
    }
    if (this.inThinking) {
      stream.markdown(
        `\n<details><summary>💭 Thinking</summary>\n\n${this.buffer.trim()}\n\n</details>\n\n`
      );
    } else {
      stream.markdown(this.buffer);
    }
    this.buffer = '';
    this.inThinking = false;
  }
}
