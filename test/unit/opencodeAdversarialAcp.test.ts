import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  AcpClient,
  OpenCodeError,
  type SpawnedProcess,
} from '../../src/llm/opencode/acp';

/** Fully scriptable fake `opencode acp` process. */
class HostileFake implements SpawnedProcess {
  stdoutListeners: Array<(chunk: string) => void> = [];
  exitListeners: Array<(code: number | null) => void> = [];
  killed: string[] = [];
  written: string[] = [];
  /** 'hang' = never answer prompts; 'garbage-result' = result without stopReason. */
  promptMode: 'normal' | 'hang' | 'garbage-result' = 'normal';
  failPromptWith: string | undefined;
  permissionBehavior: 'allow' | 'deny' | 'empty-options' | 'throw' = 'allow';
  permissionSeen = 0;
  sessionCounter = 0;

  writeStdin(data: string): void {
    this.written.push(data);
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      void Promise.resolve().then(() => this.handle(trimmed));
    }
  }

  onStdout(l: (chunk: string) => void): void { this.stdoutListeners.push(l); }
  onExit(l: (code: number | null) => void): void { this.exitListeners.push(l); }
  kill(signal?: NodeJS.Signals): void {
    this.killed.push(signal ?? 'SIGTERM');
    this.exitListeners.forEach((l) => l(null));
  }
  emit(obj: unknown): void {
    const line = JSON.stringify(obj) + '\n';
    this.stdoutListeners.forEach((l) => l(line));
  }
  die(code: number | null): void {
    this.exitListeners.forEach((l) => l(code));
  }

  private handle(line: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.method === 'initialize') {
      this.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 999, agentCapabilities: {} } });
      return;
    }
    if (msg.method === 'session/new') {
      this.sessionCounter += 1;
      this.emit({
        jsonrpc: '2.0', id: msg.id,
        result: {
          sessionId: `ses_${this.sessionCounter}`,
          configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'M' }] }],
        },
      });
      return;
    }
    if (msg.method === 'session/resume') {
      this.emit({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'session/set_config_option') {
      this.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'unknown model nope' } });
      return;
    }
    if (msg.method === 'session/close') {
      this.emit({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'session/cancel') return;
    if (msg.method === 'session/prompt') {
      void this.runPrompt(msg);
      return;
    }
    this.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }

  private async runPrompt(msg: { id?: number; method?: string; params?: Record<string, unknown> }): Promise<void> {
    const sessionId = (msg.params?.sessionId as string) ?? 'ses_x';
    if (this.permissionBehavior === 'throw') {
      this.permissionSeen += 1;
      this.emit({
        jsonrpc: '2.0', id: 700 + this.permissionSeen, method: 'session/request_permission',
        params: { sessionId, toolCall: { toolCallId: 'c1' }, options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }] },
      });
      await new Promise((r) => setTimeout(r, 30));
    } else if (this.permissionBehavior === 'empty-options') {
      this.permissionSeen += 1;
      this.emit({
        jsonrpc: '2.0', id: 700 + this.permissionSeen, method: 'session/request_permission',
        params: { sessionId, toolCall: { toolCallId: 'c1' }, options: [] },
      });
      await new Promise((r) => setTimeout(r, 30));
    } else if (this.permissionBehavior === 'deny') {
      this.permissionSeen += 1;
      this.emit({
        jsonrpc: '2.0', id: 700 + this.permissionSeen, method: 'session/request_permission',
        params: { sessionId, toolCall: { toolCallId: 'c1' }, options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }] },
      });
      await new Promise((r) => setTimeout(r, 30));
    }
    if (this.promptMode === 'hang') return;
    if (this.failPromptWith) {
      this.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: this.failPromptWith } });
      return;
    }
    if (this.promptMode === 'garbage-result') {
      this.emit({ jsonrpc: '2.0', id: msg.id, result: { nonsense: true } });
      return;
    }
    this.emit({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } },
    });
    // Hostile extras the client must tolerate.
    this.emit({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'zzz' } } },
    });
    this.emit({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'mystery_update', frobnicate: true } },
    });
    this.emit({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'c9', status: 'weird-status' } },
    });
    this.emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
}

describe('AcpClient adversarial', () => {
  let fake: HostileFake;
  let client: AcpClient;
  let granted: string[];

  beforeEach(() => {
    fake = new HostileFake();
    granted = [];
    client = new AcpClient(
      { spawn: () => fake },
      async (request) => {
        if (fake.permissionBehavior === 'throw') {
          throw new Error('UI exploded');
        }
        const first = request.options[0]?.optionId;
        if (fake.permissionBehavior === 'deny') {
          return first;
        }
        if (first) {
          granted.push(first);
        }
        return first;
      }
    );
  });

  it('process dying mid-prompt rejects with crashed (kind preserved)', async () => {
    fake.promptMode = 'hang';
    await client.start('opencode', '/tmp');
    const pending = client.prompt('ses_1', 'hi', { onText: () => undefined });
    await new Promise((r) => setTimeout(r, 20));
    fake.die(1);
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof OpenCodeError);
      assert.equal((err as OpenCodeError).kind, 'crashed');
      assert.match((err as Error).message, /exited/);
      return true;
    });
    assert.equal(client.running, false);
  });

  it('billing/model failures classify as provider-error with message intact', async () => {
    fake.failPromptWith = 'Billing hard limit reached (payment required)';
    await client.start('opencode', '/tmp');
    await assert.rejects(
      client.prompt('ses_1', 'hi', { onText: () => undefined }),
      (err: unknown) => {
        assert.ok(err instanceof OpenCodeError);
        assert.equal((err as OpenCodeError).kind, 'provider-error');
        assert.match((err as Error).message, /Billing hard limit/);
        return true;
      }
    );
  });

  it('garbage prompt results degrade to end_turn instead of crashing', async () => {
    fake.promptMode = 'garbage-result';
    await client.start('opencode', '/tmp');
    const result = await client.prompt('ses_1', 'hi', { onText: () => undefined });
    assert.equal(result.stopReason, 'end_turn');
  });

  it('non-text chunks, unknown updates, and odd tool statuses are tolerated', async () => {
    await client.start('opencode', '/tmp');
    const texts: string[] = [];
    const tools: string[] = [];
    await client.prompt('ses_1', 'hi', {
      onText: (t) => texts.push(t),
      onTool: (e) => tools.push(e.status),
    });
    assert.deepEqual(texts, ['x']);
    assert.deepEqual(tools, ['pending']);
  });

  it('a throwing permission resolver answers with error; prompt survives', async () => {
    fake.permissionBehavior = 'throw';
    await client.start('opencode', '/tmp');
    const result = await client.prompt('ses_1', 'hi', { onText: () => undefined });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(fake.permissionSeen, 1);
  });

  it('empty permission options resolve to cancelled outcome', async () => {
    fake.permissionBehavior = 'empty-options';
    await client.start('opencode', '/tmp');
    const result = await client.prompt('ses_1', 'hi', { onText: () => undefined });
    assert.equal(result.stopReason, 'end_turn');
    // Resolver got [] and returned undefined -> cancelled outcome.
    assert.deepEqual(granted, []);
  });

  it('unadvertised fs/terminal calls get method-not-found (agent uses own tools)', async () => {
    await client.start('opencode', '/tmp');
    // Reach into the peer via a direct unknown-method call from the fake side:
    // simulate agent calling fs/read_text_file by emitting it as a request.
    const seen: string[] = [];
    const origWrite = fake.writeStdin.bind(fake);
    fake.writeStdin = (data: string) => {
      seen.push(data);
      origWrite(data);
    };
    // Trigger: the fake emits a client-bound request and we observe the
    // error response on the wire.
    fake.emit({ jsonrpc: '2.0', id: 4242, method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
    await new Promise((r) => setTimeout(r, 30));
    const responses = fake.written
      .flatMap((w) => w.split('\n'))
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { id?: number; error?: { code: number } })
      .filter((m) => m.id === 4242);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error?.code, -32601);
  });

  it('concurrent prompts on one session are rejected, not interleaved', async () => {
    fake.promptMode = 'hang';
    await client.start('opencode', '/tmp');
    const first = client.prompt('ses_1', 'one', { onText: () => undefined });
    await assert.rejects(
      client.prompt('ses_1', 'two', { onText: () => undefined }),
      (err: unknown) => {
        assert.ok(err instanceof OpenCodeError);
        assert.equal((err as OpenCodeError).kind, 'protocol-error');
        return true;
      }
    );
    fake.die(0);
    await assert.rejects(first);
  });

  it('unknown model values surface the backend error on setModel', async () => {
    await client.start('opencode', '/tmp');
    await assert.rejects(client.setModel('ses_1', 'nope'), /unknown model/);
  });

  it('cancel() and closeSession() on a dead client never throw', async () => {
    await client.start('opencode', '/tmp');
    fake.die(1);
    client.cancel('ses_1');
    await client.closeSession('ses_1');
    await client.dispose();
    // Already exited: dispose must NOT attempt another kill.
    assert.deepEqual(fake.killed, []);
  });
});
