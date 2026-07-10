import OpenAI from 'openai';
import type {
  LLMProvider,
  Message,
  StreamChunk,
  ToolSchema,
} from './types';

function toOpenAIMessages(messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

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
      const textParts = msg.content.filter((c) => c.type === 'text');
      const toolCalls = msg.content.filter((c) => c.type === 'tool_call');
      const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: textParts.map((c) => (c as { text: string }).text).join('') || null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => {
          const t = tc as { id: string; name: string; arguments: string };
          return {
            id: t.id,
            type: 'function' as const,
            function: { name: t.name, arguments: t.arguments },
          };
        });
      }
      result.push(assistantMsg);
    } else if (msg.role === 'tool') {
      for (const c of msg.content) {
        if (c.type === 'tool_result') {
          result.push({
            role: 'tool',
            tool_call_id: c.toolCallId,
            content: c.content,
          });
        }
      }
    }
  }

  return result;
}

export interface OpenAIProviderOptions {
  baseURL?: string;
  id?: string;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
}

export function createOpenAIProvider(
  apiKey: string,
  model: string,
  options: OpenAIProviderOptions = {}
): LLMProvider {
  const client = new OpenAI({
    apiKey,
    baseURL: options.baseURL || undefined,
    defaultHeaders: options.defaultHeaders,
  });
  const resolvedModel = model || options.defaultModel || 'gpt-4o';

  return {
    id: options.id ?? 'openai',
    async *chat(params: {
      messages: Message[];
      tools: ToolSchema[];
      signal: AbortSignal;
    }): AsyncIterable<StreamChunk> {
      const openaiTools: OpenAI.Chat.ChatCompletionTool[] = params.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));

      const stream = await client.chat.completions.create(
        {
          model: resolvedModel,
          messages: toOpenAIMessages(params.messages),
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
          stream: true,
        },
        { signal: params.signal }
      );

      const pendingToolCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) {
          continue;
        }

        if (choice.delta.content) {
          yield { type: 'text', text: choice.delta.content };
        }

        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!pendingToolCalls.has(idx)) {
              pendingToolCalls.set(idx, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                arguments: '',
              });
            }
            const existing = pendingToolCalls.get(idx)!;
            if (tc.id) {
              existing.id = tc.id;
            }
            if (tc.function?.name) {
              existing.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
          }
        }

        if (choice.finish_reason === 'tool_calls') {
          const toolCalls = Array.from(pendingToolCalls.values());
          for (const tc of toolCalls) {
            yield {
              type: 'tool_call',
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            };
          }
          yield { type: 'done', stopReason: 'tool_calls', toolCalls };
          return;
        }

        if (choice.finish_reason === 'stop') {
          yield { type: 'done', stopReason: 'end' };
          return;
        }
      }

      yield { type: 'done', stopReason: 'end' };
    },
  };
}
