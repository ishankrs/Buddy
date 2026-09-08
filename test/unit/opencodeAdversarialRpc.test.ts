import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JsonRpcPeer, RpcError } from '../../src/llm/opencode/rpc';

function harness(onRequest?: (method: string, params: unknown) => Promise<unknown>) {
  const written: string[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const parseErrors: string[] = [];
  const listeners: Array<(chunk: string) => void> = [];
  const peer = new JsonRpcPeer(
    { onData: (l) => listeners.push(l) },
    { writeLine: (line) => written.push(line) },
    {
      onNotification: (method, params) => notifications.push({ method, params }),
      onRequest: onRequest ?? (() => Promise.reject(new RpcError('nope', -32601))),
      onParseError: (line) => parseErrors.push(line),
    }
  );
  return { peer, written, notifications, parseErrors, receive: (t: string) => listeners.forEach((l) => l(t)) };
}

// Deterministic pseudo-random generator (fixed seed — no flaky fuzz).
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

describe('JsonRpcPeer adversarial', () => {
  it('survives garbage, split, and batched hostile input', async () => {
    const h = harness();
    const rand = lcg(42);
    const results: Array<Promise<unknown>> = [];
    const ids: number[] = [];
    for (let i = 0; i < 50; i++) {
      const p = h.peer.call(`m${i}`, { i });
      results.push(p);
      ids.push(JSON.parse(h.written[h.written.length - 1] as string).id as number);
    }
    // Build one hostile blob: garbage lines, empty lines, responses in
    // random order, each chopped at random boundaries.
    let blob = '\n\nnot json at all\n{"broken": \n';
    const order = [...ids].sort(() => rand() - 0.5);
    for (const id of order) {
      blob += JSON.stringify({ jsonrpc: '2.0', id, result: id * 2 }) + '\n';
    }
    blob += '{"jsonrpc":"2.0","method":"evil","params":{}}\n';
    blob += '\n';
    let pos = 0;
    while (pos < blob.length) {
      const step = 1 + Math.floor(rand() * 17);
      h.receive(blob.slice(pos, pos + step));
      pos += step;
    }
    const values = await Promise.all(results);
    assert.deepEqual(values, ids.map((id) => id * 2));
    assert.equal(h.notifications.length, 1);
    assert.ok(h.parseErrors.length >= 2);
    assert.equal(h.peer.pendingCount, 0);
  });

  it('ignores duplicate and unknown-id responses', async () => {
    const h = harness();
    const pending = h.peer.call('ping', {});
    const id = JSON.parse(h.written[0] as string).id as number;
    h.receive(JSON.stringify({ jsonrpc: '2.0', id: 9999, result: 'ghost' }) + '\n');
    h.receive(JSON.stringify({ jsonrpc: '2.0', id, result: 'first' }) + '\n');
    h.receive(JSON.stringify({ jsonrpc: '2.0', id, result: 'second' }) + '\n');
    assert.equal(await pending, 'first');
    assert.equal(h.peer.pendingCount, 0);
  });

  it('handles a 5MB single-line payload', async () => {
    const h = harness();
    const big = 'x'.repeat(5 * 1024 * 1024);
    const pending = h.peer.call('big', {});
    const id = JSON.parse(h.written[0] as string).id as number;
    const line = JSON.stringify({ jsonrpc: '2.0', id, result: big }) + '\n';
    // Feed in uneven halves.
    h.receive(line.slice(0, 1_000_003));
    h.receive(line.slice(1_000_003));
    assert.equal((await pending as string).length, big.length);
  });

  it('rejects with the agent error code, not a generic message', async () => {
    const h = harness();
    const pending = h.peer.call('doom', {});
    const id = JSON.parse(h.written[0] as string).id as number;
    h.receive(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'provider exploded' } }) + '\n');
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof RpcError);
      assert.equal((err as RpcError).code, -32001);
      return true;
    });
  });

  it('a throwing onRequest handler yields an error response, not a hang', async () => {
    const h = harness(async () => {
      throw new Error('handler blew up');
    });
    h.receive(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'x', params: {} }) + '\n');
    await new Promise((r) => setTimeout(r, 20));
    const out = JSON.parse(h.written[0] as string) as { id: number; error: { message: string } };
    assert.equal(out.id, 3);
    assert.match(out.error.message, /blew up/);
  });

  it('null/invalid envelopes never resolve or crash', async () => {
    const h = harness();
    const pending = h.peer.call('ping', {});
    const id = JSON.parse(h.written[0] as string).id as number;
    for (const line of ['null', '[]', '42', '"str"', '{"nope":1}', '{"jsonrpc":"1.0","id":1}']) {
      h.receive(line + '\n');
    }
    // The real response still works afterwards.
    h.receive(JSON.stringify({ jsonrpc: '2.0', id, result: 'ok' }) + '\n');
    assert.equal(await pending, 'ok');
  });
});
