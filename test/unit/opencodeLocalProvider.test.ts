import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOpencodePrompt,
  createOpencodeLocalProvider,
  extractWorkspaceContext,
} from '../../src/llm/opencode/localProvider';
import type { OpenCodeProcessManager } from '../../src/llm/opencode/manager';
import type { Message } from '../../src/llm/types';

function text(role: Message['role'], body: string): Message {
  return { role, content: [{ type: 'text', text: body }] };
}

const SYSTEM_WITH_CONTEXT = [
  'You are Buddy. You have tools to read files.',
  '## Current workspace context',
  'Active file: foo.ts',
].join('\n');

describe('extractWorkspaceContext', () => {
  it('forwards only the workspace context section', () => {
    const out = extractWorkspaceContext([text('system', SYSTEM_WITH_CONTEXT)]);
    assert.equal(out, 'Active file: foo.ts');
    assert.ok(!out.includes('You have tools'));
  });

  it('returns empty when the marker is absent', () => {
    assert.equal(extractWorkspaceContext([text('system', 'hello')]), '');
    assert.equal(extractWorkspaceContext([]), '');
  });
});

describe('buildOpencodePrompt', () => {
  const messages: Message[] = [
    text('system', SYSTEM_WITH_CONTEXT),
    text('user', 'first question'),
    text('assistant', 'first answer'),
    text('user', 'second question'),
  ];

  it('sends only the new message plus context for resumed sessions', () => {
    const prompt = buildOpencodePrompt(messages, false, false);
    assert.ok(prompt.includes('second question'));
    assert.ok(prompt.includes('Active file: foo.ts'));
    assert.ok(!prompt.includes('first question'));
    assert.ok(!prompt.includes('You have tools'));
  });

  it('includes history for fresh sessions', () => {
    const prompt = buildOpencodePrompt(messages, false, true);
    assert.ok(prompt.includes('first question'));
    assert.ok(prompt.includes('first answer'));
    assert.ok(prompt.includes('second question'));
  });

  it('adds a no-edits instruction in plan mode', () => {
    const prompt = buildOpencodePrompt(messages, true, false);
    assert.ok(prompt.includes('Do NOT modify files'));
  });
});

describe('createOpencodeLocalProvider', () => {
  function fakeManager(behavior: {
    created?: boolean;
    chunks?: Array<{ kind: 'text' | 'activity'; text: string }>;
    failWith?: unknown;
    seenModels?: string[];
  } = {}) {
    const seenModels: string[] = behavior.seenModels ?? [];
    const manager = {
      ensureSession: async () => ({ sessionId: 'ses_1', created: behavior.created ?? false }),
      setModel: async (_ws: string, model: string) => {
        seenModels.push(model);
        return [];
      },
      promptOnSession: async (
        _id: string,
        _text: string,
        events: {
          onText(t: string): void;
          onThought?(t: string): void;
          onTool?(e: { toolCallId: string; status: string; title?: string }): void;
        }
      ) => {
        for (const chunk of behavior.chunks ?? [{ kind: 'text' as const, text: 'answer' }]) {
          if (chunk.kind === 'text') {
            events.onText(chunk.text);
          } else {
            events.onThought?.(chunk.text);
          }
        }
        if (behavior.failWith) {
          throw behavior.failWith;
        }
        return { stopReason: 'end_turn', cancelled: false };
      },
    };
    return { manager: manager as unknown as OpenCodeProcessManager, seenModels };
  }

  async function collect(provider: ReturnType<typeof createOpencodeLocalProvider>, messages: Message[]) {
    const chunks = [];
    const controller = new AbortController();
    for await (const chunk of provider.chat({ messages, tools: [], signal: controller.signal })) {
      chunks.push(chunk);
    }
    return chunks;
  }

  const messages: Message[] = [text('system', SYSTEM_WITH_CONTEXT), text('user', 'do it')];

  it('has the opencode id and streams text then done', async () => {
    const { manager } = fakeManager();
    const provider = createOpencodeLocalProvider({
      manager,
      workspacePath: '/work',
      model: '',
      planMode: false,
    });
    assert.equal(provider.id, 'opencode');
    const chunks = await collect(provider, messages);
    assert.deepEqual(chunks, [
      { type: 'text', text: 'answer' },
      { type: 'done', stopReason: 'end' },
    ]);
  });

  it('applies the configured model best-effort', async () => {
    const { manager, seenModels } = fakeManager();
    const provider = createOpencodeLocalProvider({
      manager,
      workspacePath: '/work',
      model: 'other/model-x',
      planMode: false,
    });
    await collect(provider, messages);
    assert.deepEqual(seenModels, ['other/model-x']);
  });

  it('surfaces thoughts as activity chunks, never as answer text', async () => {
    const { manager } = fakeManager({
      chunks: [
        { kind: 'activity', text: 'reasoning here' },
        { kind: 'text', text: 'final' },
      ],
    });
    const provider = createOpencodeLocalProvider({
      manager,
      workspacePath: '/work',
      model: '',
      planMode: false,
    });
    const chunks = await collect(provider, messages);
    assert.deepEqual(chunks, [
      { type: 'activity', text: 'Thinking: reasoning here' },
      { type: 'text', text: 'final' },
      { type: 'done', stopReason: 'end' },
    ]);
  });

  it('propagates backend errors to the caller', async () => {
    const { manager } = fakeManager({ failWith: new Error('provider exploded') });
    const provider = createOpencodeLocalProvider({
      manager,
      workspacePath: '/work',
      model: '',
      planMode: false,
    });
    await assert.rejects(collect(provider, messages), /provider exploded/);
  });

  it('requires no API key and persists no credential', async () => {
    // The adapter receives no key material at all: options carry only
    // workspace/model/mode, and chat() takes messages/tools/signal.
    const { manager } = fakeManager();
    const provider = createOpencodeLocalProvider({
      manager,
      workspacePath: '/work',
      model: '',
      planMode: false,
    });
    const chunks = await collect(provider, [
      text('user', 'tell me about OPENCODE_API_KEY handling'),
    ]);
    const serialized = JSON.stringify(chunks);
    assert.ok(!serialized.includes('sk-'));
    assert.ok(!serialized.includes('apiKey'));
  });
});
