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
      ['anthropic', 'custom', 'ollama', 'openai', 'openrouter'].sort()
    );
  });
});
