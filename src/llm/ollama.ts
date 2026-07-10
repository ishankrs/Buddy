import * as vscode from 'vscode';
import type {
  LLMProvider,
  Message,
  StreamChunk,
  ToolSchema,
} from './types';

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

function toOllamaMessages(messages: Message[]): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('');
      result.push({ role: 'system', content: text });
    } else if (msg.role === 'user') {
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('');
      result.push({ role: 'user', content: text });
    } else if (msg.role === 'assistant') {
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('');
      const toolCalls = msg.content
        .filter((c) => c.type === 'tool_call')
        .map((c) => {
          const tc = c as { name: string; arguments: string };
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.arguments || '{}');
          } catch {
            args = {};
          }
          return { function: { name: tc.name, arguments: args } };
        });
      result.push({
        role: 'assistant',
        content: text,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    } else if (msg.role === 'tool') {
      for (const c of msg.content) {
        if (c.type === 'tool_result') {
          result.push({ role: 'tool', content: c.content });
        }
      }
    }
  }

  return result;
}

export function createOllamaProvider(model: string): LLMProvider {
  const resolvedModel = model || 'llama3.1';

  return {
    id: 'ollama',
    async *chat(params: {
      messages: Message[];
      tools: ToolSchema[];
      signal: AbortSignal;
    }): AsyncIterable<StreamChunk> {
      const baseUrl = vscode.workspace
        .getConfiguration('buddy')
        .get<string>('ollamaBaseUrl', 'http://localhost:11434');

      const body = {
        model: resolvedModel,
        messages: toOllamaMessages(params.messages),
        tools: params.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        stream: true,
      };

      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: params.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Ollama returned no response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let toolIndex = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          try {
            const parsed = JSON.parse(line) as {
              message?: {
                content?: string;
                tool_calls?: Array<{
                  function: { name: string; arguments: Record<string, unknown> };
                }>;
              };
              done?: boolean;
            };

            if (parsed.message?.content) {
              yield { type: 'text', text: parsed.message.content };
            }

            if (parsed.message?.tool_calls) {
              for (const tc of parsed.message.tool_calls) {
                const id = `ollama_${toolIndex++}`;
                const args = JSON.stringify(tc.function.arguments ?? {});
                toolCalls.push({ id, name: tc.function.name, arguments: args });
                yield {
                  type: 'tool_call',
                  id,
                  name: tc.function.name,
                  arguments: args,
                };
              }
            }

            if (parsed.done) {
              if (toolCalls.length > 0) {
                yield { type: 'done', stopReason: 'tool_calls', toolCalls };
              } else {
                yield { type: 'done', stopReason: 'end' };
              }
              return;
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      if (toolCalls.length > 0) {
        yield { type: 'done', stopReason: 'tool_calls', toolCalls };
      } else {
        yield { type: 'done', stopReason: 'end' };
      }
    },
  };
}
