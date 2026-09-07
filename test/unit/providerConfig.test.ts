import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROVIDERS } from '../../src/llm/providerCatalog';

describe('PROVIDERS', () => {
  it('includes OpenRouter with OpenAI-compatible defaults', () => {
    const openrouter = PROVIDERS.find((p) => p.id === 'openrouter');
    assert.ok(openrouter);
    assert.equal(openrouter?.defaultBaseUrl, 'https://openrouter.ai/api/v1');
    assert.ok(openrouter?.modelSuggestions.some((m) => m.startsWith('openai/')));
  });

  it('lists all supported provider ids', () => {
    assert.deepEqual(
      PROVIDERS.map((p) => p.id).sort(),
      ['anthropic', 'custom', 'ollama', 'openai', 'opencode', 'openrouter'].sort()
    );
  });

  it('includes opencode as a local backend with no API key and no endpoint', () => {
    const opencode = PROVIDERS.find((p) => p.id === 'opencode');
    assert.ok(opencode);
    assert.equal(opencode?.requiresApiKey, false);
    assert.equal(opencode?.defaultBaseUrl, undefined);
    assert.equal(opencode?.baseUrlSettingKey, undefined);
    assert.ok(opencode?.dynamicModels);
    assert.deepEqual(opencode?.modelSuggestions, []);
  });
});
