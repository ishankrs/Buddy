import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  AcpClient,
  OpenCodeError,
  type SpawnedProcess,
} from '../../src/llm/opencode/acp';

/** In-memory fake `opencode acp` process speaking ACP over the peer. */
class FakeOpenCode implements SpawnedProcess {
  stdoutListeners: Array<(chunk: string) => void> = [];
  exitListeners: Array<(code: number | null) => void> = [];
  killed: string[] = [];
  sawCancel: Array<{ sessionId: string }> = [];
  permissionRequests = 0;
  /** Fail the next session/prompt with this error message. */
  failPromptWith: string | undefined;
  /** When true, request permission during the prompt turn. */
  askPermission = false;
  currentModel = 'opencode/big-pickle';
  modelOptions = [
    { value: 'opencode/big-pickle', name: 'Big Pickle' },
    { value: 'other/model-x', name: 'Model X' },
  ];

  writeStdin(data: string): void {
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      // Answer asynchronously like a real subprocess.
      void Promise.resolve().then(() => this.handle(JSON.parse(trimmed) as Incoming));
    }
  }

  onStdout(listener: (chunk: string) => void): void {
    this.stdoutListeners.push(listener);
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }

  kill(signal?: NodeJS.Signals): void {
    this.killed.push(signal ?? 'SIGTERM');
    this.exitListeners.forEach((l) => l(null));
  }

  emit(obj: unknown): void {
    const line = JSON.stringify(obj) + '\n';
    this.stdoutListeners.forEach((l) => l(line));
  }

  private handle(msg: Incoming): void {
    if (msg.method === 'initialize') {
      this.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      return;
    }
    if (msg.method === 'session/new') {
      this.emit({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: 'ses_test1',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              currentValue: this.currentModel,
              options: this.modelOptions,
            },
          ],
        },
      });
      return;
    }
    if (msg.method === 'session/resume') {
      this.emit({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'session/set_config_option') {
      const value = (msg.params as { value: string }).value;
      this.currentModel = value;
      this.emit({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              type: 'select',
              currentValue: this.currentModel,
              options: this.modelOptions,
            },
          ],
        },
      });
      return;
    }
    if (msg.method === 'session/cancel') {
      this.sawCancel.push((msg.params ?? {}) as { sessionId: string });
      return;
    }
    if (msg.method === 'session/close') {
      this.emit({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'session/prompt') {
      void this.runPrompt(msg);
      return;
    }
    this.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }

  private async runPrompt(msg: Incoming): Promise<void> {
    const sessionId = ((msg.params ?? {}) as { sessionId: string }).sessionId;
    if (this.askPermission) {
      this.permissionRequests += 1;
      // Ask the client, then continue regardless of the answer.
      this.emit({
        jsonrpc: '2.0',
        id: 900 + this.permissionRequests,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'call_1', title: 'write', kind: 'edit', status: 'pending' },
          options: [
            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
      // Give the client a chance to answer before finishing.
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.failPromptWith) {
      this.emit({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: this.failPromptWith },
      });
      return;
    }
    this.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } },
      },
    });
    this.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
      },
    });
    this.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          title: 'write',
        },
      },
    });
    this.emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
}

interface Incoming {
  id?: number;
  method?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}

describe('AcpClient', () => {
  let fake: FakeOpenCode;
  let granted: string[];
  let client: AcpClient;

  beforeEach(() => {
    fake = new FakeOpenCode();
    granted = [];
    client = new AcpClient(
      { spawn: () => fake },
      async (request) => {
        const first = request.options[0]?.optionId;
        if (first) {
          granted.push(first);
        }
        return first;
      }
    );
  });

  async function started(): Promise<AcpClient> {
    await client.start('opencode', '/tmp');
    return client;
  }

  it('starts and initializes', async () => {
    await started();
    assert.equal(client.running, true);
  });

  it('creates sessions with config options', async () => {
    await started();
    const { sessionId, configOptions } = await client.createSession('/tmp');
    assert.equal(sessionId, 'ses_test1');
    assert.equal(configOptions[0].id, 'model');
    assert.deepEqual(client.getModelOptions(sessionId), {
      current: 'opencode/big-pickle',
      options: fake.modelOptions,
    });
  });

  it('streams prompt text and tool events, then completes', async () => {
    await started();
    const texts: string[] = [];
    const tools: string[] = [];
    const result = await client.prompt(
      'ses_test1',
      'hi',
      {
        onText: (t) => texts.push(t),
        onTool: (e) => tools.push(`${e.toolCallId}:${e.status}`),
      }
    );
    assert.deepEqual(texts, ['hel', 'lo']);
    assert.deepEqual(tools, ['call_1:completed']);
    assert.deepEqual(result, { stopReason: 'end_turn', cancelled: false });
  });

  it('routes permission requests to the resolver', async () => {
    fake.askPermission = true;
    await started();
    await client.prompt('ses_test1', 'hi', { onText: () => undefined });
    assert.equal(fake.permissionRequests, 1);
    assert.deepEqual(granted, ['once']);
  });

  it('sends session/cancel on abort without killing the process', async () => {
    await started();
    const controller = new AbortController();
    const pending = client.prompt('ses_test1', 'hi', { onText: () => undefined }, controller.signal);
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(fake.sawCancel.length, 1);
    assert.deepEqual(fake.killed, []);
    assert.equal(client.running, true);
  });

  it('switches models via set_config_option', async () => {
    await started();
    await client.createSession('/tmp');
    await client.setModel('ses_test1', 'other/model-x');
    assert.equal(client.getModelOptions('ses_test1')?.current, 'other/model-x');
  });

  it('classifies auth failures without exposing secrets', async () => {
    fake.failPromptWith = 'not authenticated, run opencode auth login';
    await started();
    const texts: string[] = [];
    await assert.rejects(
      client.prompt('ses_test1', 'hi', { onText: (t) => texts.push(t) }),
      (err: unknown) => {
        assert.ok(err instanceof OpenCodeError);
        assert.equal((err as OpenCodeError).kind, 'not-authenticated');
        assert.match((err as Error).message, /Buddy does not manage OpenCode authentication/);
        return true;
      }
    );
  });

  it('dispose() terminates the child process (no orphans)', async () => {
    await started();
    await client.dispose();
    assert.deepEqual(fake.killed, ['SIGTERM']);
    assert.equal(client.running, false);
  });

  it('closeSession forgets the session', async () => {
    await started();
    await client.createSession('/tmp');
    await client.closeSession('ses_test1');
    assert.equal(client.getCachedConfig('ses_test1').length, 0);
  });
});
