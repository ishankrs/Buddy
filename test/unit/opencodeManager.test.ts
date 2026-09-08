import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  getSharedManager,
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

interface FakeClientOptions {
  resumeOk?: boolean;
  createdId?: string;
  failCreate?: boolean;
}

function fakeClient(options: FakeClientOptions = {}) {
  const calls: string[] = [];
  const client = {
    running: true,
    start: async () => {
      calls.push('start');
    },
    resumeSession: async (id: string) => {
      calls.push(`resume:${id}`);
      return options.resumeOk ?? true;
    },
    createSession: async () => {
      calls.push('create');
      if (options.failCreate) {
        throw new OpenCodeError('nope', 'protocol-error');
      }
      return { sessionId: options.createdId ?? 'ses_new', configOptions: [] };
    },
    closeSession: async (id: string) => {
      calls.push(`close:${id}`);
    },
    prompt: async () => {
      calls.push('prompt');
      return { stopReason: 'end_turn', cancelled: false };
    },
    setModel: async () => {
      calls.push('setModel');
      return [];
    },
    getModelOptions: () => ({ current: 'm', options: [{ value: 'm', name: 'M' }] }),
    listSessions: async () => {
      calls.push('list');
      return [{ sessionId: 'ses_old', title: 'Old chat' }];
    },
    loadSession: async () => {
      calls.push('load');
      return { configOptions: [], items: [] };
    },
    dispose: async () => {
      calls.push('dispose');
    },
  };
  return { calls, client: client as unknown as AcpClient };
}

describe('OpenCodeProcessManager', () => {
  beforeEach(() => {
    resetSharedManager();
  });

  it('creates and persists a session per workspace', async () => {
    const d = deps();
    const { calls, client } = fakeClient({ createdId: 'ses_1' });
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);

    const first = await manager.ensureSession('/work/a');
    assert.deepEqual(first, { sessionId: 'ses_1', created: true });
    assert.deepEqual(calls, ['start', 'create']);

    const second = await manager.ensureSession('/work/a');
    assert.deepEqual(second, { sessionId: 'ses_1', created: false });
    assert.deepEqual(calls, ['start', 'create', 'resume:ses_1']);
  });

  it('falls back to a new session when resume fails', async () => {
    const d = deps();
    d.store.set('buddy.opencode.session.1a2b3c', 'ses_old');
    const { client } = fakeClient({ resumeOk: false, createdId: 'ses_fresh' });
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    const ensured = await manager.ensureSession('/work/a');
    assert.equal(ensured.sessionId, 'ses_fresh');
    assert.equal(ensured.created, true);
  });

  it('resetSession closes and forgets', async () => {
    const d = deps();
    const { calls, client } = fakeClient({ createdId: 'ses_1' });
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    await manager.ensureSession('/work/a');
    await manager.resetSession('/work/a');
    assert.ok(calls.includes('close:ses_1'));
    // Next ensure creates again instead of resuming.
    await manager.ensureSession('/work/a');
    assert.equal(calls.filter((c) => c === 'create').length, 2);
  });

  it('serializes concurrent prompts on one session', async () => {
    const d = deps();
    const order: string[] = [];
    const { client } = fakeClient();
    const slowClient = {
      ...client,
      prompt: async () => {
        order.push('start');
        await new Promise((r) => setTimeout(r, 30));
        order.push('end');
        return { stopReason: 'end_turn', cancelled: false };
      },
    } as unknown as AcpClient;
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => slowClient);
    await Promise.all([
      manager.prompt('/work/a', 'one', { onText: () => undefined }),
      manager.prompt('/work/a', 'two', { onText: () => undefined }),
    ]);
    assert.deepEqual(order, ['start', 'end', 'start', 'end']);
  });

  it('starts fresh when a session advertises no models', async () => {
    const d = deps();
    const { calls, client } = fakeClient({ createdId: 'ses_1' });
    const emptyClient = {
      ...client,
      getModelOptions: () => ({ current: '', options: [] }),
    } as unknown as AcpClient;
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => emptyClient);
    await assert.rejects(manager.getModelOptions('/work/a'), /did not advertise any models/);
    // Reset (close) + recreate happened before giving up.
    assert.ok(calls.includes('close:ses_1'));
    assert.equal(calls.filter((c) => c === 'create').length, 2);
  });

  it('switches workspaces to a previous session and remembers it', async () => {
    const d = deps();
    const { client } = fakeClient();
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    assert.equal(manager.currentSessionId('/work/a'), undefined);
    const ok = await manager.useSession('/work/a', 'ses_old');
    assert.equal(ok, true);
    assert.equal(manager.currentSessionId('/work/a'), 'ses_old');
    // Next prompt uses the switched session without creating a new one.
    const ensured = await manager.ensureSession('/work/a');
    assert.deepEqual(ensured, { sessionId: 'ses_old', created: false });
  });

  it('useSession reports failure without storing', async () => {
    const d = deps();
    const { client } = fakeClient({ resumeOk: false });
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    assert.equal(await manager.useSession('/work/a', 'ses_gone'), false);
    assert.equal(manager.currentSessionId('/work/a'), undefined);
  });

  it('lists previous sessions and loads history', async () => {
    const d = deps();
    const { calls, client } = fakeClient();
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    const sessions = await manager.listSessions('/work/a');
    assert.deepEqual(sessions, [{ sessionId: 'ses_old', title: 'Old chat' }]);
    const items = await manager.loadHistory('/work/a', 'ses_old');
    assert.deepEqual(items, []);
    assert.ok(calls.includes('list'));
    assert.ok(calls.includes('load'));
  });

  it('dispose() tears down the client', async () => {
    const d = deps();
    const { calls, client } = fakeClient();
    const manager = new OpenCodeProcessManager(d);
    manager.setClientFactory(() => client);
    await manager.ensureSession('/work/a');
    await manager.dispose();
    assert.ok(calls.includes('dispose'));
  });

  it('reports not-installed when detection fails and never spawns', async () => {
    let spawned = false;
    const d = deps({
      execDeps: {
        execFile: async () => {
          throw new Error('ENOENT');
        },
        exists: async () => false,
        platform: 'darwin',
        pathEnv: '',
        homeDir: '/Users/tester',
      },
      spawnDeps: {
        spawn: () => {
          spawned = true;
          throw new Error('spawned anyway');
        },
      },
    });
    const manager = new OpenCodeProcessManager(d);
    await assert.rejects(manager.ensureRunning(), (err: unknown) => {
      assert.ok(err instanceof OpenCodeError);
      assert.equal((err as OpenCodeError).kind, 'not-installed');
      return true;
    });
    assert.equal(spawned, false);
  });

  it('getSharedManager requires configuration once', () => {
    assert.throws(() => getSharedManager(), /not been configured/);
    const manager = getSharedManager(deps());
    assert.equal(getSharedManager(), manager);
  });
});
