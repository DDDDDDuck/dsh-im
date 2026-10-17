import assert from 'node:assert/strict';
import test from 'node:test';

import { harnessConnection } from '../plugin-src/host/harness-connection.mjs';
import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';

const clients = [
  ['weixin', 'HarnessClient'], ['qq', 'QqHarnessClient'], ['feishu', 'HarnessClient'],
  ['dingtalk', 'HarnessClient'], ['wecom', 'WecomHarnessClient'], ['wecom-app', 'WecomAppHarnessClient'],
  ['telegram', 'TelegramHarnessClient'], ['discord', 'DiscordHarnessClient'], ['slack', 'SlackHarnessClient'],
  ['whatsapp', 'WhatsappHarnessClient'], ['imessage', 'IMessageHarnessClient'], ['email', 'EmailHarnessClient'],
  ['matrix', 'MatrixHarnessClient'], ['office', 'HarnessClient'],
];

function fixture() {
  const lifetime = new AbortController();
  const calls = [], created = [], effects = [];
  let disposals = 0;
  const peer = {
    principal: { kind: 'owner' }, signal: lifetime.signal,
    async dispose() { disposals += 1; lifetime.abort(); },
  };
  function accept(request) {
    assert.equal(request.peer, peer, 'both unary and streaming requests must carry the Host-created peer');
    assert.equal(request.peer.signal.aborted, false);
    assert.ok(request.signal instanceof AbortSignal);
    calls.push(request);
  }
  const ctx = {
    root: {},
    connection: { createPeer(options) { created.push(options); return peer; } },
    typertGateway: {
      async invoke(request) {
        accept(request);
        switch (`${request.namespace}/${request.method}`) {
          case 'session/create': return { sessionId: 'session' };
          case 'session/modelCatalog': return { groups: [], failures: [] };
          default: throw new Error(`Unexpected endpoint ${request.namespace}/${request.method}`);
        }
      },
      async *stream(request) {
        accept(request);
        if (request.namespace === 'workspace' && request.method === 'follow') {
          yield { type: 'baseline', value: {
            items: [{ path: '/workspace', workspaceId: 'workspace' }], archivedSessionIds: [],
          } };
        } else if (request.namespace === 'session' && request.method === 'follow') {
          yield { type: 'snapshot', cursor: -1, records: [], hasMore: false };
        } else {
          throw new Error(`Unexpected stream ${request.namespace}/${request.method}`);
        }
      },
    },
    on() { return () => {}; },
    effect(setup) { effects.push(setup()); },
  };
  return { ctx, peer, calls, created, effects, get disposals() { return disposals; } };
}

for (const [channel, exportName] of clients) {
  test(`${channel} sends a live Host peer when preparing new and existing sessions and reading models`, async () => {
    const f = fixture();
    const directory = channel === 'office' ? 'shared' : channel;
    const file = channel === 'matrix' ? 'matrix-harness-client' : 'harness-client';
    const { [exportName]: Client } = await import(`../src/channels/${directory}/${file}.mjs`);
    const client = new Client({ ...harnessConnection(f.ctx), workspace: '/workspace' });
    try {
      assert.equal(await client.createSession(), 'session');
      assert.equal(await client.sessionExists('session'), true);
      assert.deepEqual(await client.listModels(), { groups: [], failures: [] });
      assert.deepEqual(f.created, [{ principal: { kind: 'owner' }, interactions: 'none' }]);
      assert.ok(f.calls.some(request => request.namespace === 'session' && request.method === 'create'));
      assert.ok(f.calls.some(request => request.namespace === 'workspace' && request.method === 'follow'));
      assert.equal(f.peer.signal.aborted, false, 'closing a baseline stream must not dispose the shared peer');
    } finally {
      for (const dispose of f.effects) await dispose();
    }
    assert.equal(f.disposals, 1);
    assert.equal(f.peer.signal.aborted, true);
  });
}

test('one peer is shared by a Host adapter, released on unload, and replaced on reload', async () => {
  const f = fixture();
  const api = modernHarnessApi(f.ctx);
  assert.equal(modernHarnessApi({ ...f.ctx }), api);
  assert.equal(f.created.length, 1);
  let finish;
  f.peer.dispose = () => {
    finish = Promise.withResolvers();
    return finish.promise;
  };
  const pending = f.effects[0]();
  assert.ok(pending instanceof Promise, 'the Host must await peer disposal');
  finish.resolve();
  await pending;
  const reloaded = fixture();
  reloaded.ctx.root = f.ctx.root;
  assert.notEqual(modernHarnessApi(reloaded.ctx), api);
  assert.equal(reloaded.created.length, 1);
  assert.notEqual(reloaded.peer, f.peer);
  assert.equal(reloaded.peer.signal.aborted, false);
  await reloaded.effects[0]();
  const other = fixture();
  assert.notEqual(modernHarnessApi(other.ctx), api);
  assert.equal(other.created.length, 1);
  await other.effects[0]();
});

test('older Hosts without createPeer retain their existing request format', async () => {
  const f = fixture();
  f.ctx.connection = {};
  f.ctx.typertGateway.invoke = async request => {
    assert.equal(Object.hasOwn(request, 'peer'), false);
    return { items: [] };
  };
  const api = modernHarnessApi(f.ctx);
  assert.deepEqual(await api.sessions.list({ rpcId: 'legacy', payload: {} }), {
    rpcId: 'legacy', result: { ok: true, value: { items: [] } },
  });
  await f.effects[0]();
  assert.equal(f.created.length, 0);
});
