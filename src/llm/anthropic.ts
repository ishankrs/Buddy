import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  Message,
  StreamChunk,
  ToolSchema,
} from './types';

function toAnthropicMessages(messages: Message[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  let system = '';
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += msg.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('');
      continue;
    }

    if (msg.role === 'user') {
      const text = msg.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('');
      if (text) {
        result.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const c of msg.content) {
        if (c.type === 'text' && c.text) {
          blocks.push({ type: 'text', text: c.text });
        } else if (c.type === 'tool_call') {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(c.arguments || '{}');
          } catch {
            input = {};
          }
          blocks.push({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input,
          });
        }
      }
      if (blocks.length > 0) {
        result.push({ role: 'assistant', content: blocks });
      }
    } else if (msg.role === 'tool') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const c of msg.content) {
        if (c.type === 'tool_result') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: c.toolCallId,
            content: c.content,
          });
        }
      }
      if (toolResults.length > 0) {
        result.push({ role: 'user', content: toolResults });
      }
    }
  }

  return { system, messages: result };
}

export function createAnthropicProvider(
  apiKey: string,
  model: string,
  baseURL?: string
): LLMProvider {
  const client = new Anthropic({
    apiKey,
    baseURL: baseURL || undefined,
  });
  const resolvedModel = model || 'claude-sonnet-4-20250514';

  return {
    id: 'anthropic',
    async *chat(params: {
      messages: Message[];
      tools: ToolSchema[];
      signal: AbortSignal;
    }): AsyncIterable<StreamChunk> {
      const { system, messages } = toAnthropicMessages(params.messages);

      const anthropicTools: Anthropic.Tool[] = params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      }));

      const stream = client.messages.stream(
        {
          model: resolvedModel,
          max_tokens: 8192,
          system: system || undefined,
          messages,
          tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        },
        { signal: params.signal }
      );

      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let currentToolId = '';
      let currentToolName = '';
      let currentToolArgs = '';

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            yield { type: 'text', text: delta.text };
          } else if (delta.type === 'input_json_delta') {
            currentToolArgs += delta.partial_json;
          }
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            currentToolId = block.id;
            currentToolName = block.name;
            currentToolArgs = '';
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolId && currentToolName) {
            toolCalls.push({
              id: currentToolId,
              name: currentToolName,
              arguments: currentToolArgs || '{}',
            });
            yield {
              type: 'tool_call',
              id: currentToolId,
              name: currentToolName,
              arguments: currentToolArgs || '{}',
            };
            currentToolId = '';
            currentToolName = '';
            currentToolArgs = '';
          }
        } else if (event.type === 'message_delta') {
          if (event.delta.stop_reason === 'tool_use') {
            yield { type: 'done', stopReason: 'tool_calls', toolCalls };
            return;
          }
          if (event.delta.stop_reason === 'end_turn') {
            yield { type: 'done', stopReason: 'end' };
            return;
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
