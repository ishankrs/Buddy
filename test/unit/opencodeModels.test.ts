import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  OPENCODE_ZEN_MODELS_URL,
  clearOpencodeModelsCache,
  fetchOpencodeModels,
  groupOpencodeModels,
  isFreeOpencodeModel,
  parseOpencodeModelsResponse,
  resolveOpencodeModelsUrl,
  sortOpencodeModels,
  type FetchFn,
} from '../../src/llm/opencodeModels';

describe('isFreeOpencodeModel', () => {
  it('treats -free suffixed ids as free', () => {
    assert.equal(isFreeOpencodeModel('mimo-v2.5-free'), true);
    assert.equal(isFreeOpencodeModel('deepseek-v4-flash-free'), true);
    assert.equal(
      isFreeOpencodeModel('muse-spark-1.3-contributor-free'),
      true
    );
  });

  it('treats the big-pickle stealth model as free', () => {
    assert.equal(isFreeOpencodeModel('big-pickle'), true);
  });

  it('treats everything else as paid', () => {
    assert.equal(isFreeOpencodeModel('kimi-k2.5'), false);
    assert.equal(isFreeOpencodeModel('deepseek-v4-pro'), false);
    assert.equal(isFreeOpencodeModel('claude-opus-5'), false);
    assert.equal(isFreeOpencodeModel('gpt-5'), false);
  });
});

describe('parseOpencodeModelsResponse', () => {
  it('extracts ids from the Zen list shape', () => {
    assert.deepEqual(
      parseOpencodeModelsResponse({
        object: 'list',
        data: [{ id: 'kimi-k2.5' }, { id: 'big-pickle' }],
      }),
      ['kimi-k2.5', 'big-pickle']
    );
  });

  it('returns [] for malformed bodies', () => {
    assert.deepEqual(parseOpencodeModelsResponse(null), []);
    assert.deepEqual(parseOpencodeModelsResponse({}), []);
    assert.deepEqual(parseOpencodeModelsResponse({ data: 'nope' }), []);
    assert.deepEqual(
      parseOpencodeModelsResponse({ data: [{ id: 42 }, {}, { id: '  ' }] }),
      []
    );
  });
});

describe('groupOpencodeModels', () => {
  it('lists free first (alphabetical), then paid (alphabetical), deduped', () => {
    const grouped = groupOpencodeModels([
      'kimi-k2.5',
      'mimo-v2.5-free',
      'deepseek-v4-pro',
      'big-pickle',
      'kimi-k2.5',
      'deepseek-v4-flash-free',
    ]);
    assert.deepEqual(
      grouped.free.map((m) => m.id),
      ['big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free']
    );
    assert.deepEqual(
      grouped.paid.map((m) => m.id),
      ['deepseek-v4-pro', 'kimi-k2.5']
    );
  });
});

describe('sortOpencodeModels', () => {
  it('flattens free before paid', () => {
    assert.deepEqual(
      sortOpencodeModels(['gpt-5', 'big-pickle']).map((m) => m.id),
      ['big-pickle', 'gpt-5']
    );
  });
});

describe('resolveOpencodeModelsUrl', () => {
  it('swaps a trailing /chat/completions for a sibling /models', () => {
    assert.equal(
      resolveOpencodeModelsUrl('https://opencode.ai/zen/v1/chat/completions'),
      'https://opencode.ai/zen/v1/models'
    );
  });

  it('keeps an explicit models url as-is', () => {
    assert.equal(
      resolveOpencodeModelsUrl('https://example.com/x/models'),
      'https://example.com/x/models'
    );
  });

  it('falls back to the canonical url', () => {
    assert.equal(resolveOpencodeModelsUrl(undefined), OPENCODE_ZEN_MODELS_URL);
    assert.equal(resolveOpencodeModelsUrl(''), OPENCODE_ZEN_MODELS_URL);
    assert.equal(resolveOpencodeModelsUrl('not a url'), OPENCODE_ZEN_MODELS_URL);
    assert.equal(
      resolveOpencodeModelsUrl('https://proxy.example.com/v1'),
      OPENCODE_ZEN_MODELS_URL
    );
  });
});

describe('fetchOpencodeModels', () => {
  beforeEach(() => {
    clearOpencodeModelsCache();
  });

  const stubFetch = (body: unknown, status = 200): FetchFn => {
    return async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  };

  it('fetches, classifies, and sorts the live list', async () => {
    const models = await fetchOpencodeModels({
      fetchFn: stubFetch({
        data: [{ id: 'kimi-k2.5' }, { id: 'big-pickle' }],
      }),
    });
    assert.deepEqual(models, [
      { id: 'big-pickle', free: true },
      { id: 'kimi-k2.5', free: false },
    ]);
  });

  it('sends the api key as a bearer token when provided', async () => {
    let seen: Record<string, string> | undefined;
    const models = await fetchOpencodeModels({
      apiKey: 'sk-test',
      fetchFn: (async (url, init) => {
        seen = init?.headers;
        assert.ok(url.includes('/models'));
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a-free' }] }) };
      }) as FetchFn,
    });
    assert.equal(seen?.Authorization, 'Bearer sk-test');
    assert.deepEqual(models, [{ id: 'a-free', free: true }]);
  });

  it('throws on http errors', async () => {
    await assert.rejects(
      fetchOpencodeModels({ fetchFn: stubFetch({}, 401) }),
      /HTTP 401/
    );
  });

  it('throws on network failures', async () => {
    await assert.rejects(
      fetchOpencodeModels({
        fetchFn: async () => {
          throw new Error('boom');
        },
      }),
      /Could not reach/
    );
  });

  it('throws on empty lists', async () => {
    await assert.rejects(
      fetchOpencodeModels({ fetchFn: stubFetch({ data: [] }) }),
      /empty model list/
    );
  });

  it('caches within ttl and refresh bypasses the cache', async () => {
    let calls = 0;
    const counting: FetchFn = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'x-free' }] }) };
    };
    await fetchOpencodeModels({ fetchFn: counting });
    await fetchOpencodeModels({ fetchFn: counting });
    assert.equal(calls, 1);
    await fetchOpencodeModels({ fetchFn: counting, refresh: true });
    assert.equal(calls, 2);
  });
});
