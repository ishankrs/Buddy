import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modeLabel, resolveMode } from '../../src/agent/modes';

describe('resolveMode', () => {
  it('maps chat commands to agent modes', () => {
    assert.equal(resolveMode('plan'), 'plan');
    assert.equal(resolveMode('think'), 'think');
    assert.equal(resolveMode('debug'), 'debug');
    assert.equal(resolveMode('swarm'), 'swarm');
    assert.equal(resolveMode('subagent'), 'subagent');
  });

  it('returns default for unknown or missing commands', () => {
    assert.equal(resolveMode(undefined), 'default');
    assert.equal(resolveMode(''), 'default');
    assert.equal(resolveMode('unknown'), 'default');
  });
});

describe('modeLabel', () => {
  it('returns human-readable labels', () => {
    assert.equal(modeLabel('plan'), 'Plan');
    assert.equal(modeLabel('think'), 'Think');
    assert.equal(modeLabel('debug'), 'Debug');
    assert.equal(modeLabel('swarm'), 'Swarm');
    assert.equal(modeLabel('subagent'), 'Subagent');
    assert.equal(modeLabel('default'), 'Agent');
  });
});
