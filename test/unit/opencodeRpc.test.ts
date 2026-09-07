import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JsonRpcPeer, RpcError } from '../../src/llm/opencode/rpc';

interface Harness {
  peer: JsonRpcPeer;
  /** Bytes the peer wrote (one JSON message per line). */
  written: string[];
  /** Feed inbound bytes into the peer. */
  receive(text: string): void;
  received: Array<{ method: string; params: unknown }>;
}

function harness(onRequest?: (method: string, params: unknown) => Promise<unknown>): Harness {
  const written: string[] = [];
  const received: Array<{ method: string; params: unknown }> = [];
  const listeners: Array<(chunk: string) => void> = [];
  const peer = new JsonRpcPeer(
    { onData: (l) => listeners.push(l) },
    { writeLine: (line) => written.push(line) },
    {
      onNotification: (method, params) => received.push({ method, params }),
      onRequest: onRequest ?? (() => Promise.reject(new RpcError('nope', -32601))),
    }
  );
  return {
    peer,
    written,
    received,
    receive: (text) => listeners.forEach((l) => l(text)),
  };
}

function lastMessage(h: Harness) {
  return JSON.parse(h.written[h.written.length - 1] ?? '{}') as {
    id?: number;
    method?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params?: any;
  };
}

describe('JsonRpcPeer', () => {
  it('round-trips a request/response', async () => {
    const h = harness();
    const pending = h.peer.call('initialize', { protocolVersion: 1 });
    assert.equal(lastMessage(h).method, 'initialize');
    const id = lastMessage(h).id as number;
    h.receive(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }) + '\n');
    assert.deepEqual(await pending, { ok: true });
  });

  it('rejects on error responses', async () => {
    const h = harness();
    const pending = h.peer.call('session/prompt', {});
    const id = lastMessage(h).id as number;
    h.receive(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'bad auth' } }) + '\n');
    await assert.rejects(pending, /bad auth/);
  });

  it('buffers split lines across chunks', async () => {
    const h = harness();
    const pending = h.peer.call('ping', {});
    const id = lastMessage(h).id as number;
    const full = JSON.stringify({ jsonrpc: '2.0', id, result: 1 }) + '\n';
    h.receive(full.slice(0, 10));
    h.receive(full.slice(10));
    assert.equal(await pending, 1);
  });

  it('routes notifications without responding', async () => {
    const h = harness();
    h.receive(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } }) + '\n');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(h.received, [{ method: 'session/update', params: { a: 1 } }]);
    assert.equal(h.written.length, 0);
  });

  it('answers incoming method calls and 404s unknown ones', async () => {
    const h = harness(async (method) => {
      if (method === 'known') {
        return { yes: true };
      }
      throw new RpcError('Method not found: ' + method, -32601);
    });
    h.receive(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'known', params: {} }) + '\n');
    h.receive(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'fs/read_text_file', params: {} }) + '\n');
    await new Promise((r) => setTimeout(r, 20));
    const out = h.written.map((w) => JSON.parse(w) as { id: number; result?: unknown; error?: { code: number } });
    assert.deepEqual(out.find((m) => m.id === 7)?.result, { yes: true });
    assert.equal(out.find((m) => m.id === 8)?.error?.code, -32601);
  });

  it('ignores malformed lines and keeps working', async () => {
    const seen: string[] = [];
    const listeners: Array<(c: string) => void> = [];
    const peer = new JsonRpcPeer(
      { onData: (l) => listeners.push(l) },
      { writeLine: () => undefined },
      { onParseError: (line) => seen.push(line) }
    );
    const pending = peer.call('ping', {});
    listeners.forEach((l) => l('not json\n'));
    assert.equal(seen.length, 1);
    listeners.forEach((l) => l(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }) + '\n'));
    assert.equal(await pending, 'ok');
  });

  it('close() fails pending requests and rejects new ones', async () => {
    const h = harness();
    const pending = h.peer.call('ping', {});
    h.peer.close(new Error('gone'));
    await assert.rejects(pending, /gone/);
    await assert.rejects(h.peer.call('ping', {}), /gone/);
  });

  it('notify() sends no-id messages', () => {
    const h = harness();
    h.peer.notify('session/cancel', { sessionId: 's' });
    assert.deepEqual(lastMessage(h), {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 's' },
    });
  });
});
