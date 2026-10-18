import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { GroupHistoryStore } from '../src/channels/shared/group-history-store.mjs';
import { GroupHistoryAccessRegistry, createGroupHistoryTools } from '../src/channels/shared/group-history-access.mjs';
import { captureGroupHistory, groupHistoryEntry } from '../src/channels/shared/group-history.mjs';
import { createGroupHistoryRpcHandler, GROUP_HISTORY_ENDPOINTS } from '../plugin-src/host/group-history-rpc.mjs';

const DAY = 86400000;
const base = Date.parse('2026-10-18T12:00:00Z');
const entry = (messageId, extra = {}) => ({ channel: 'whatsapp', groupId: 'test@g.us',
  groupName: 'test', messageId, senderId: 'person', sentAt: base, text: `message ${messageId}`, ...extra });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-group-history-'));
  let now = base;
  const store = new GroupHistoryStore(root, { now: () => now, logger: { warn() {} }, ...options });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const group = await store.capture(entry('discover'), { discover: true });
  return { root, store, groupId: group.groupId, advance: (ms) => { now += ms; } };
}

test('silent capture is opt-in, shared across bots, deduplicated and independent of sessions', async (t) => {
  const { store, groupId } = await fixture(t);
  assert.equal((await store.query(groupId)).items.length, 0);
  assert.equal((await store.settings()).groupHistoryRetentionDays, 14);
  await store.setEnabled(groupId, true);
  let downloads = 0;
  await store.capture(entry('m1'));
  await store.capture(entry('m1', { attachments: [{ key: 'file:0', name: 'a.txt', load: async () => {
    downloads += 1; return Buffer.from('shared content');
  } }] }));
  await store.idle();
  await store.capture(entry('m1', { attachments: [{ key: 'file:0', load: () => { throw new Error('duplicate download'); } }] }));
  const page = await store.query(groupId);
  assert.deepEqual(JSON.parse(JSON.stringify(page)), page, 'Host tool output must be lossless JSON');
  const filesPage = await store.query(groupId, { kind: 'files' });
  assert.deepEqual(JSON.parse(JSON.stringify(filesPage)), filesPage);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].attachments[0].status, 'ready');
  assert.equal(downloads, 1);
  await store.setEnabled(groupId, false);
  await store.capture(entry('m2'));
  assert.equal((await store.query(groupId)).items.length, 1);
});

test('archive files are group-scoped; model edits only affect copies; copies have cleanup', async (t) => {
  const { store, groupId, root, advance } = await fixture(t);
  await store.setEnabled(groupId, true);
  await store.capture(entry('file', { attachments: [{ key: 'file:0', name: '../../original.txt',
    load: async function* () { yield Buffer.from('first '); yield Buffer.from('second'); } }] }));
  await store.idle();
  const id = (await store.query(groupId, { kind: 'files' })).items[0].id;
  await assert.rejects(store.materialize('other-group', id, root), /不属于当前群/);
  const copy = await store.materialize(groupId, id, root);
  const { cleanup: _cleanup, ...publicCopy } = copy;
  assert.deepEqual(JSON.parse(JSON.stringify(publicCopy)), publicCopy);
  assert.equal(await readFile(copy.path, 'utf8'), 'first second');
  await writeFile(copy.path, 'changed');
  const another = await store.materialize(groupId, id, root);
  assert.equal(await readFile(another.path, 'utf8'), 'first second');
  await copy.cleanup(); await another.cleanup();
  await assert.rejects(readFile(copy.path), { code: 'ENOENT' });
  advance(15 * DAY);
  await assert.rejects(store.materialize(groupId, id, root), /已过期/);
  assert.equal((await store.sweep()).deletedMessages, 1);
});

test('download failures and oversize streams do not stall capture', async (t) => {
  const { store, groupId } = await fixture(t, { maxFileBytes: 4 });
  await store.setEnabled(groupId, true);
  await store.capture(entry('files', { attachments: [
    { key: 'large', load: async function* () { yield Buffer.from('123'); yield Buffer.from('456'); } },
    { key: 'fail', load: () => { throw new Error('https://secret-token.example'); } },
    { key: 'good', load: () => Buffer.from('ok') },
  ] }));
  await store.idle();
  const files = (await store.query(groupId, { kind: 'files' })).items;
  assert.equal(files.filter((item) => item.status === 'ready').length, 1);
  assert.equal(files.filter((item) => item.status === 'unavailable').length, 1);
  assert.equal(files.filter((item) => item.status === 'failed').length, 1);
  assert.doesNotMatch(JSON.stringify(files), /secret-token/);
});

test('a provider ignoring cancellation still releases its slot after the download timeout', async (t) => {
  const { store, groupId } = await fixture(t, { downloadTimeoutMs: 20 });
  await store.setEnabled(groupId, true);
  await store.capture(entry('hung', { attachments: [{ key: 'hang', load: () => new Promise(() => {}) }] }));
  await Promise.all([store.idle(), delay(50)]);
  assert.equal((await store.query(groupId, { kind: 'files' })).items[0].status, 'failed');
});

test('retention persists, cleans more than one batch, and reads exclude overdue rows immediately', async (t) => {
  const { store, groupId, root, advance } = await fixture(t);
  await store.setEnabled(groupId, true);
  for (let i = 0; i < 505; i++) await store.capture(entry(`old-${i}`));
  advance(15 * DAY);
  assert.equal((await store.query(groupId)).items.length, 0);
  assert.equal((await store.sweep()).deletedMessages, 505);
  await store.setRetentionDays(30);
  assert.equal(JSON.parse(await readFile(join(root, 'general-settings.json'), 'utf8')).groupHistoryRetentionDays, 30);
  assert.equal((await store.query(groupId)).items.length, 0);
  for (const bad of [0, -1, 1.5, '2a', null]) await assert.rejects(store.setRetentionDays(bad));
});

test('corrupt retention settings fail closed and can be repaired explicitly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-group-history-corrupt-'));
  await writeFile(join(root, 'general-settings.json'), '{broken');
  const store = new GroupHistoryStore(root);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  assert.ok((await store.settings()).error);
  assert.ok((await store.sweep()).error);
  await assert.rejects(store.query('group'), /暂停自动清理/);
  await store.setRetentionDays(30);
  assert.deepEqual(await store.settings(), { groupHistoryRetentionDays: 30 });
});

test('queries paginate within byte budget and reject cross-group cursors', async (t) => {
  const { store, groupId } = await fixture(t);
  await store.setEnabled(groupId, true);
  for (let i = 0; i < 5; i++) await store.capture(entry(`long-${i}`, { text: '群'.repeat(9000),
    attachments: Array.from({ length: 15 }, (_, index) => ({ key: String(index), name: '附'.repeat(512) })) }));
  await store.idle();
  const ids = new Set(); let cursor;
  do {
    const page = await store.query(groupId, { cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 24000);
    for (const item of page.items) { assert.equal(ids.has(item.id), false); ids.add(item.id); assert.ok(item.textTruncated); }
    cursor = page.nextCursor;
    if (cursor) {
      const other = await store.capture(entry('other', { groupId: 'other@g.us' }), { discover: true });
      await assert.rejects(store.query(other.groupId, { cursor }), /游标无效/);
    }
  } while (cursor);
  assert.equal(ids.size, 5);
});

test('discovery checks access; Telegram/Slack use source message identity, not delivery or thread identity', async () => {
  let captured;
  const store = { capture: async (...args) => { captured = args; return { store, groupId: 'g' }; } };
  const message = { kind: 'group', senderId: 'person', addressed: false };
  await captureGroupHistory(store, message, entry('x'));
  assert.equal(captured[1].discover, false);
  message.addressed = true;
  await captureGroupHistory(store, message, entry('x'), { allowed: false });
  assert.equal(captured[1].discover, false);
  await captureGroupHistory(store, message, entry('x'));
  assert.equal(captured[1].discover, true);
  const tg = groupHistoryEntry('telegram', { update_id: 20, message: { message_id: 10, chat: { id: -1 }, message_thread_id: 3 } }, message);
  assert.equal(tg.messageId, '10'); assert.equal(tg.groupId, '-1'); assert.equal(tg.threadId, '3');
  const slack = groupHistoryEntry('slack', { event_id: 'Ev1', team_id: 'T1', event: { channel: 'C1', ts: '1700000000.1', thread_ts: '1700000000.0' } }, message);
  assert.equal(slack.groupId, 'C1'); assert.equal(slack.messageId, '1700000000.1');
});

test('host-bound access rejects invented, ended, Web, mixed-group and switched-session requests', async () => {
  const registry = new GroupHistoryAccessRegistry();
  const store = { query: async (groupId) => ({ groupId }) };
  const session = { id: 's1', header: { cwd: '/tmp' }, events: [] };
  const start = (turn) => { const event = { type: 'turn/start', data: { turn } }; session.events.push(event); registry.observe(session, event); };
  const tools = createGroupHistoryTools(registry);
  const exec = { agent: { session } };
  const close = registry.open('s1', 'rpc1', { store, groupId: 'g1' });
  start(1); registry.claim(session, { source: { rpcId: 'rpc1' } }, 1);
  for (const kind of ['runtime-context', 'time-context', 'plugin:dsh-im']) {
    registry.observe(session, { type: 'user/message', data: { source: { kind, form: 'snapshot' } } });
  }
  assert.deepEqual(await tools[0].execute({}, exec), { groupId: 'g1' });
  assert.equal(registry.resolve({ ...session, id: 's2' }), null);
  registry.claim(session, { source: { rpcId: 'web-rpc' } }, 1);
  assert.throws(() => tools[0].execute({}, exec), /authorized request/);
  start(2); registry.claim(session, { source: { rpcId: 'rpc1' } }, 2);
  const closeOther = registry.open('s1', 'rpc2', { store, groupId: 'g2' });
  registry.claim(session, { source: { rpcId: 'rpc2' } }, 2);
  assert.equal(registry.resolve(session), null);
  closeOther();
  start(3); registry.claim(session, { source: { rpcId: 'rpc1' } }, 3);
  let cleaned = false; registry.trackCopy(session, async () => { cleaned = true; });
  close(); await Promise.resolve();
  assert.equal(cleaned, true); assert.equal(registry.resolve(session), null);
});

test('settings RPC rejects unknown parameters and persists valid retention', async (t) => {
  const { store, groupId } = await fixture(t);
  const rpc = createGroupHistoryRpcHandler(store);
  assert.equal((await rpc(GROUP_HISTORY_ENDPOINTS.set, { groupHistoryRetentionDays: 3 })).value.groupHistoryRetentionDays, 3);
  assert.equal((await rpc(GROUP_HISTORY_ENDPOINTS.enable, { groupId, enabled: true })).ok, true);
  assert.equal((await rpc(GROUP_HISTORY_ENDPOINTS.set, { groupHistoryRetentionDays: 0 })).ok, false);
  assert.equal((await rpc(GROUP_HISTORY_ENDPOINTS.get, { groupId })).ok, false);
});
