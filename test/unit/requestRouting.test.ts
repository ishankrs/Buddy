import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveUserMessageAndMode } from '../../src/agent/requestRouting';

describe('resolveUserMessageAndMode', () => {
  it('uses explicit chat commands over natural-language detection', () => {
    assert.deepEqual(
      resolveUserMessageAndMode('debug', 'open a subagent to write tests'),
      { mode: 'debug', userMessage: 'open a subagent to write tests' }
    );
  });

  it('detects subagent intent in default mode', () => {
    assert.deepEqual(
      resolveUserMessageAndMode(undefined, 'spawn a subagent to refactor auth.ts'),
      { mode: 'subagent', userMessage: 'refactor auth.ts' }
    );
  });

  it('keeps default mode for regular prompts', () => {
    assert.deepEqual(resolveUserMessageAndMode(undefined, 'explain this file'), {
      mode: 'default',
      userMessage: 'explain this file',
    });
  });
});
