import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSidebarSettingsRpcHandler, hasConfiguredChannel, SidebarSettingsStore } from '../plugin-src/host/sidebar-settings.mjs';
import { QqConfigStore, deriveQqBotIdentity } from '../src/channels/qq/config-store.mjs';
import { WeixinConfigStore, deriveWeixinBotIdentity } from '../src/channels/weixin/config-store.mjs';
import { OfficeConfigStore } from '../src/channels/office/config-store.mjs';
import { installInboundTtlRpc } from '../plugin-src/host/inbound-ttl-rpc.mjs';

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('auto follows saved channels across additions, removals and restart; forced modes persist', async (t) => {
  const dshHome = await home(t);
  const config = { dshHome };
  const call = createSidebarSettingsRpcHandler({ config });
  const get = () => call('settings.sidebar-entry.get', {});
  assert.deepEqual(await get(), { ok: true, value: { mode: 'auto', visible: true } });
  const wx = await new WeixinConfigStore(join(dshHome, 'integrations/dsh-weixin/config.json')).load();
  const wxId = deriveWeixinBotIdentity('account@im.bot');
  await wx.save({ ...wxId, accountId: 'account@im.bot', ownerUserId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' });
  assert.deepEqual((await get()).value, { mode: 'auto', visible: false });
  const qq = await new QqConfigStore(join(dshHome, 'integrations/dsh-qq/config.json')).load();
  const qqId = deriveQqBotIdentity('102345678');
  await qq.save({ ...qqId, appId: '102345678', ownerUserOpenid: 'owner' });
  await wx.remove(wxId.botId);
  assert.equal((await get()).value.visible, false);
  const set = (mode) => call('settings.sidebar-entry.set', { mode });
  assert.deepEqual((await set('show')).value, { mode: 'show', visible: true });
  assert.deepEqual((await createSidebarSettingsRpcHandler({ config })('settings.sidebar-entry.get', {})).value,
    { mode: 'show', visible: true });
  await qq.remove(qqId.botId);
  assert.deepEqual((await set('hide')).value, { mode: 'hide', visible: false });
  assert.deepEqual((await set('auto')).value, { mode: 'auto', visible: true });
});

test('Office-only setup and custom channel paths count without starting connections', async (t) => {
  const dshHome = await home(t);
  const officePath = join(dshHome, 'custom', 'office.json');
  const office = await new OfficeConfigStore(officePath).load();
  await office.save({ baseUrl: 'https://office.example.com', deviceId: 'test-device',
    deviceTokenRef: 'DSH_OFFICE_DEVICE_TOKEN_1234567890ABCDEF12345678' });
  assert.equal(await hasConfiguredChannel({ dshHome }), false);
  assert.equal(await hasConfiguredChannel({ dshHome, office: { configPath: officePath } }), true);
  await office.clear();
  const qq = await new QqConfigStore(join(dshHome, 'custom', 'config.json')).load();
  await qq.save({ ...deriveQqBotIdentity('102345678'), appId: '102345678', ownerUserOpenid: 'owner' });
  assert.equal(await hasConfiguredChannel({ dshHome, qq: { dataDir: join(dshHome, 'custom') } }), true);
});

test('bad configuration is not an empty channel list; forced modes remain usable', async (t) => {
  const dshHome = await home(t);
  await mkdir(join(dshHome, 'integrations/dsh-qq'), { recursive: true });
  await writeFile(join(dshHome, 'integrations/dsh-qq/config.json'), '{broken');
  const call = createSidebarSettingsRpcHandler({ config: { dshHome } });
  assert.equal((await call('settings.sidebar-entry.get', {})).ok, false);
  assert.deepEqual((await call('settings.sidebar-entry.set', { mode: 'show' })).value, { mode: 'show', visible: true });
  assert.deepEqual((await call('settings.sidebar-entry.set', { mode: 'hide' })).value, { mode: 'hide', visible: false });
  assert.equal((await call('settings.sidebar-entry.set', { mode: 'auto' })).ok, false);
  assert.equal((await call('settings.sidebar-entry.get', {})).value.mode, 'hide', 'failed save retains prior preference');
});

test('invalid and cancelled RPC requests never write; store serializes writes', async (t) => {
  const root = await home(t);
  const path = join(root, 'sidebar.json');
  const store = new SidebarSettingsStore(path);
  const call = createSidebarSettingsRpcHandler({ store, configured: async () => false });
  for (const payload of [null, [], {}, { mode: true }, { mode: 'invalid' }, { mode: 'show', extra: true }]) {
    assert.equal((await call('settings.sidebar-entry.set', payload)).error.code, 'bad-request');
  }
  assert.equal((await call('settings.sidebar-entry.get', { extra: true })).ok, false);
  const signal = AbortSignal.abort();
  assert.equal((await call('settings.sidebar-entry.set', { mode: 'hide' }, signal)).error.code, 'cancelled');
  assert.equal(await store.get(), 'auto');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await Promise.all(['show', 'hide', 'auto'].map((mode) => store.set(mode)));
  assert.equal(await new SidebarSettingsStore(path).get(), 'auto');
  await writeFile(path, '{broken');
  assert.equal((await call('settings.sidebar-entry.get', {})).ok, false);
  assert.equal((await call('settings.sidebar-entry.set', { mode: 'show' })).ok, true);
});

test('shared general settings route dispatches sidebar RPC and keeps loopback authority', async (t) => {
  let registration;
  const dshHome = await home(t);
  const ctx = { connection: { fetch: { register(options) { registration = options; return () => {}; } } } };
  installInboundTtlRpc(ctx, { config: { dshHome }, runtime: {
    store: { getTtlHours() { return 24; }, setTtlHours() {} }, service: { sweepNow() {} },
  }, groupHistory: {} });
  const request = (host) => new Request(`http://${host}/api/dsh-im/dsh-im-settings`, {
    method: 'POST', headers: { host, 'content-type': 'application/json' }, body: JSON.stringify({
      type: 'client-request', rpcId: 'sidebar', method: 'dsh-im/dsh-im-settings',
      payload: { method: 'settings.sidebar-entry.get', payload: {} },
    }),
  });
  assert.equal((await registration.fetch(request('192.168.1.1'))).status, 403);
  const response = await registration.fetch(request('localhost'));
  assert.deepEqual((await response.json()).result, { ok: true, value: { mode: 'auto', visible: true } });
});
