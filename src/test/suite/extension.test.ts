import * as assert from 'assert';
import * as vscode from 'vscode';
import { getToolDefinitions } from '../../tools/registry';

const EXTENSION_ID = 'buddy.buddy';

suite('Buddy extension integration', () => {
  test('extension is present and activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} not found`);

    await extension!.activate();
    assert.ok(extension!.isActive);
  });

  test('registers buddy commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
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
      assert.ok(commands.includes(command), `Missing command: ${command}`);
    }
  });

  test('exposes core agent tools including web and subagent tools', () => {
    const tools = getToolDefinitions({ includeSpawnSubagent: true });
    const names = tools.map((tool) => tool.schema.name).sort();

    assert.deepEqual(names, [
      'edit_file',
      'fetch_url',
      'list_files',
      'read_file',
      'run_terminal',
      'search_web',
      'search_workspace',
      'spawn_subagent',
    ]);
  });

  test('buddy configuration defaults are readable', () => {
    const config = vscode.workspace.getConfiguration('buddy');
    assert.ok(
      ['openai', 'anthropic', 'openrouter', 'ollama', 'custom'].includes(
        config.get('provider', 'openai')
      )
    );
    assert.equal(typeof config.get('maxIterations', 25), 'number');
    assert.equal(typeof config.get('webSearch.enabled', true), 'boolean');
  });
});
