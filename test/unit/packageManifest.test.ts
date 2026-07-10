import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8')
) as {
  name: string;
  publisher: string;
  main: string;
  contributes: {
    chatParticipants?: Array<{ id: string; commands?: Array<{ name: string }> }>;
    commands?: Array<{ command: string }>;
  };
};

describe('package.json manifest', () => {
  it('declares the extension entry point', () => {
    assert.equal(packageJson.main, './dist/extension.js');
  });

  it('registers the buddy chat participant and mode commands', () => {
    const participant = packageJson.contributes.chatParticipants?.find((p) => p.id === 'buddy.chat');
    assert.ok(participant);

    const commandNames = participant?.commands?.map((c) => c.name) ?? [];
    assert.deepEqual(commandNames.sort(), ['debug', 'plan', 'subagent', 'swarm', 'think'].sort());
  });

  it('declares MIT license', () => {
    assert.equal((packageJson as { license?: string }).license, 'MIT');
  });

  it('registers core buddy commands', () => {
    const commands = packageJson.contributes.commands?.map((c) => c.command) ?? [];
    for (const expected of [
      'buddy.setApiKey',
      'buddy.configureEndpoint',
      'buddy.clearMemory',
      'buddy.openPanel',
      'buddy.switchUi',
      'buddy.setWebSearchApiKey',
      'buddy.selectProviderModel',
      'buddy.selectModel',
      'buddy.openLlmSettings',
    ]) {
      assert.ok(commands.includes(expected), `missing command ${expected}`);
    }
  });
});
