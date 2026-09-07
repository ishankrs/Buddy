import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  candidatePaths,
  findOpencodeBinary,
  type ExecDeps,
} from '../../src/llm/opencode/detector';

function deps(overrides: Partial<ExecDeps> = {}): ExecDeps {
  return {
    execFile: async () => {
      throw new Error('not found');
    },
    exists: async () => false,
    platform: 'darwin',
    pathEnv: '/usr/bin:/bin',
    homeDir: '/Users/tester',
    ...overrides,
  };
}

describe('candidatePaths', () => {
  it('includes user-level and system locations', () => {
    const paths = candidatePaths('/Users/tester', 'darwin');
    assert.ok(paths.includes('/Users/tester/.opencode/bin/opencode'));
    assert.ok(paths.includes('/Users/tester/.local/bin/opencode'));
    assert.ok(paths.includes('/opt/homebrew/bin/opencode'));
  });

  it('adds a windows location on win32', () => {
    const paths = candidatePaths('C:\\Users\\tester', 'win32');
    assert.ok(paths.some((p) => p.endsWith('opencode.exe')));
  });
});

describe('findOpencodeBinary', () => {
  it('prefers an explicit custom path', async () => {
    const d = await findOpencodeBinary(
      deps({
        exists: async (p) => p === '/custom/opencode',
        execFile: async () => 'opencode 1.2.3\n',
      }),
      '/custom/opencode'
    );
    assert.deepEqual(d, { ok: true, path: '/custom/opencode', version: '1.2.3' });
  });

  it('rejects a missing custom path', async () => {
    const d = await findOpencodeBinary(deps(), '/nope/opencode');
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.match(d.reason, /not found/);
    }
  });

  it('resolves opencode from PATH', async () => {
    const d = await findOpencodeBinary(
      deps({ execFile: async () => 'opencode version 1.18.29' })
    );
    assert.deepEqual(d, { ok: true, path: 'opencode', version: '1.18.29' });
  });

  it('falls back to well-known locations', async () => {
    const d = await findOpencodeBinary(
      deps({
        exists: async (p) => p === '/Users/tester/.opencode/bin/opencode',
        execFile: async (path) => {
          if (path === '/Users/tester/.opencode/bin/opencode') {
            return '9.9.9';
          }
          throw new Error('ENOENT');
        },
      })
    );
    assert.deepEqual(d, {
      ok: true,
      path: '/Users/tester/.opencode/bin/opencode',
      version: '9.9.9',
    });
  });

  it('reports not-found when nothing resolves', async () => {
    const d = await findOpencodeBinary(deps());
    assert.equal(d.ok, false);
    if (!d.ok) {
      assert.match(d.reason, /not found/i);
    }
  });
});
