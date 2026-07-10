export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolCallContent {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolCallId: string;
  name: string;
  content: string;
}

export type MessageContent = TextContent | ToolCallContent | ToolResultContent;

export interface Message {
  role: MessageRole;
  content: MessageContent[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamTextChunk {
  type: 'text';
  text: string;
}

export interface StreamToolCallChunk {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: string;
}

export interface StreamDoneChunk {
  type: 'done';
  stopReason: 'end' | 'tool_calls';
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export type StreamChunk = StreamTextChunk | StreamToolCallChunk | StreamDoneChunk;

export interface LLMProvider {
  id: string;
  chat(params: {
    messages: Message[];
    tools: ToolSchema[];
    signal: AbortSignal;
  }): AsyncIterable<StreamChunk>;
}

export interface ChatTurnResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}
