import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSystemPrompt } from '../../src/agent/prompts';

describe('buildSystemPrompt', () => {
  it('includes workspace context and base capabilities', () => {
    const prompt = buildSystemPrompt({
      mode: 'default',
      planMode: false,
      contextSummary: 'Active file: src/app.ts',
    });

    assert.match(prompt, /Buddy, an expert coding agent/);
    assert.match(prompt, /search_web/);
    assert.match(prompt, /Active file: src\/app\.ts/);
    assert.match(prompt, /spawn_subagent/);
  });

  it('adds plan-mode instructions', () => {
    const prompt = buildSystemPrompt({
      mode: 'plan',
      planMode: true,
      contextSummary: '',
    });

    assert.match(prompt, /Mode: Plan/);
    assert.match(prompt, /WITHOUT making any file edits/);
  });

  it('adds think-mode instructions', () => {
    const prompt = buildSystemPrompt({
      mode: 'think',
      planMode: false,
      contextSummary: '',
    });

    assert.match(prompt, /Mode: Think/);
    assert.match(prompt, /<thinking>/);
  });

  it('adds debug-mode instructions', () => {
    const prompt = buildSystemPrompt({
      mode: 'debug',
      planMode: false,
      contextSummary: '',
    });

    assert.match(prompt, /Mode: Debug/);
    assert.match(prompt, /root cause/);
  });
});
