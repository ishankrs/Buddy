import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_ACTIONS,
  buildHelpMarkdown,
  isAgentAction,
  parseActionCommand,
} from '../../src/agent/commands';

describe('parseActionCommand', () => {
  it('parses actions with and without trailing text', () => {
    assert.deepEqual(parseActionCommand('/new'), { action: 'new', rest: '' });
    assert.deepEqual(parseActionCommand('/new explain this'), {
      action: 'new',
      rest: 'explain this',
    });
    assert.deepEqual(parseActionCommand('  /models  '), { action: 'models', rest: '' });
    assert.deepEqual(parseActionCommand('/PROVIDER'), { action: 'provider', rest: '' });
    assert.deepEqual(parseActionCommand('/help me'), { action: 'help', rest: 'me' });
  });

  it('ignores modes, plain text, and mid-text slashes', () => {
    assert.equal(parseActionCommand('/plan refactor'), undefined);
    assert.equal(parseActionCommand('/think'), undefined);
    assert.equal(parseActionCommand('hello world'), undefined);
    assert.equal(parseActionCommand('use /new please'), undefined);
    assert.equal(parseActionCommand('/bogus'), undefined);
    assert.equal(parseActionCommand('/'), undefined);
    assert.equal(parseActionCommand(''), undefined);
  });
});

describe('isAgentAction', () => {
  it('matches only declared actions', () => {
    assert.equal(isAgentAction('new'), true);
    assert.equal(isAgentAction('models'), true);
    assert.equal(isAgentAction('plan'), false);
    assert.equal(isAgentAction(''), false);
  });
});

describe('AGENT_ACTIONS', () => {
  it('declares new, models, provider, and help', () => {
    assert.deepEqual(
      AGENT_ACTIONS.map((a) => a.name).sort(),
      ['help', 'models', 'new', 'provider']
    );
  });
});

describe('buildHelpMarkdown', () => {
  it('lists every action and the modes', () => {
    const help = buildHelpMarkdown();
    for (const action of ['/new', '/models', '/provider', '/help']) {
      assert.ok(help.includes(action), `missing ${action}`);
    }
    for (const mode of ['/plan', '/think', '/debug', '/swarm', '/subagent']) {
      assert.ok(help.includes(mode), `missing ${mode}`);
    }
  });
});
