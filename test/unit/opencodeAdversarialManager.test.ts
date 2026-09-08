import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  OpenCodeProcessManager,
  resetSharedManager,
  type ManagerDeps,
} from '../../src/llm/opencode/manager';
import { AcpClient, OpenCodeError } from '../../src/llm/opencode/acp';

function deps(overrides: Partial<ManagerDeps> = {}): ManagerDeps {
  const data = new Map<string, string>();
  return {
    execDeps: {
      execFile: async () => 'opencode 1.0.0',
      exists: async () => false,
      platform: 'darwin',
      pathEnv: '',
      homeDir: '/Users/tester',
    },
    spawnDeps: {
      spawn: () => {
        throw new Error('should be stubbed');
      },
    },
    store: {
      get: (key) => data.get(key),
      set: (key, value) => {
        data.set(key, value);
      },
      delete: (key) => {
        data.delete(key);
      },
    },
    permissionResolver: async () => undefined,
    ...overrides,
  };
}

function fakeClient() {
  const calls: string[] = [];
  const client = {
    running: true,
    start: async () => {
      calls.push('start');
    },
    resumeSession: async () => {
      calls.push('resume');
      return true;
    },
    createSession: async () => {
      calls.push('create');
      return { sessionId: 'ses_1', configOptions: [] };
    },
    closeSession: async () => {
      calls.push('close');
    },
    prompt: async () => {
      calls.push('prompt');
      await new Promise((r) => setTimeout(r, 10));
      return { stopReason: 'end_turn', cancelled: false };
    },
    setModel: async () => [],
    getModelOptions: () => ({ current: 'm', options: [{ value: 'm', name: 'M' }] }),
    dispose: async () => {
      calls.push('dispose');
    },
  };
  return { calls, client: client as unknown as AcpClient };
}

describe('OpenCodeProcessManager adversarial', () => {
  beforeEach(() => {
    resetSharedManager();
  });

  it('concurrent ensureRunning starts the process exactly once', async () => {
    const d = deps();
    let starts = 0;
    const { client } = fakeClient();
    const slow = {
      ...client,
      start: async () => {
        starts += 1;
        await new Promise((r) => setTimeout(r, 30));
      },
    } as unknown as AcpClient;
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => slow);
    await Promise.all([
      manager.ensureRunning(),
      manager.ensureRunning(),
      manager.ensureRunning(),
      manager.ensureSession('/w'),
      manager.ensureSession('/w'),
    ]);
    assert.equal(starts, 1);
  });

  it('a failing createSession leaves no phantom stored session', async () => {
    const d = deps();
    const stored = new Map<string, string>();
    d.store = {
      get: (k) => stored.get(k),
      set: (k, v) => stored.set(k, v),
      delete: (k) => stored.delete(k),
    };
    const { client } = fakeClient();
    const failing = {
      ...client,
      createSession: async () => {
        throw new OpenCodeError('backend exploded', 'protocol-error');
      },
    } as unknown as AcpClient;
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => failing);
    await assert.rejects(manager.ensureSession('/w'), /exploded/);
    assert.equal(stored.size, 0);
  });

  it('pre-aborted prompts never reach the backend', async () => {
    const d = deps();
    const { calls, client } = fakeClient();
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    const controller = new AbortController();
    controller.abort();
    const result = await manager.prompt('/w', 'hi', { onText: () => undefined }, controller.signal);
    assert.deepEqual(result.cancelled, true);
    assert.ok(!calls.includes('prompt'));
  });

  it('resetSession with nothing stored is a safe no-op', async () => {
    const d = deps();
    const { calls, client } = fakeClient();
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    await manager.resetSession('/nothing');
    assert.deepEqual(calls, []);
  });

  it('double dispose never throws', async () => {
    const d = deps();
    const { client } = fakeClient();
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    await manager.ensureSession('/w');
    await manager.dispose();
    await manager.dispose();
  });

  it('a failing store surfaces instead of silently losing sessions', async () => {
    const d = deps();
    d.store = {
      get: () => undefined,
      set: () => {
        throw new Error('disk full');
      },
      delete: () => undefined,
    };
    const { client } = fakeClient();
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    await assert.rejects(manager.ensureSession('/w'), /disk full/);
  });
});
