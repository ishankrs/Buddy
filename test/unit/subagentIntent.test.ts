import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSubagentIntent } from '../../src/agent/subagentIntent';

describe('parseSubagentIntent', () => {
  it('detects open/spawn subagent phrasing', () => {
    assert.deepEqual(parseSubagentIntent('open a subagent to write tests for auth.ts'), {
      task: 'write tests for auth.ts',
    });
    assert.deepEqual(parseSubagentIntent('Can you spawn a sub-agent to fix lint in src/utils'), {
      task: 'fix lint in src/utils',
    });
    assert.deepEqual(parseSubagentIntent('@buddy please launch subagent to refactor logger'), {
      task: 'refactor logger',
    });
  });

  it('detects delegate and subagent: shorthand', () => {
    assert.deepEqual(parseSubagentIntent('delegate this to a subagent: add integration tests'), {
      task: 'add integration tests',
    });
    assert.deepEqual(parseSubagentIntent('subagent: document the API routes'), {
      task: 'document the API routes',
    });
  });

  it('returns null when no subagent intent is present', () => {
    assert.equal(parseSubagentIntent('fix the failing test'), null);
    assert.equal(parseSubagentIntent(''), null);
    assert.equal(parseSubagentIntent('   '), null);
    assert.equal(parseSubagentIntent('use subagent tool in the registry'), null);
  });
});
