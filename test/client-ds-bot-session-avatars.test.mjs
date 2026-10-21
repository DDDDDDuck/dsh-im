import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { installDsBotSessionAvatars } from '../plugin-src/client/ds-bot-session-avatars.js';
import { DsBotAvatar } from '../plugin-src/client/ds-bot-avatar.js';

function fixture(t, rpcCall) {
  let install, cleanup, component;
  let registered = false;
  const timers = new Map();
  const controller = installDsBotSessionAvatars({ slots: {
    inject(name, callback) {
      assert.equal(name, 'sidebar.session.row.leading');
      install = callback;
      return () => { cleanup?.(); cleanup = null; install = null; };
    },
    register(options, value) {
      assert.equal(options.name, 'sidebar.session.row.leading');
      assert.equal(registered, false);
      registered = true;
      component = value;
      return () => { registered = false; };
    },
  } }, {
    rpcCall,
    setTimeoutFn: (callback, delay) => { const key = {}; timers.set(key, { callback, delay }); return key; },
    clearTimeoutFn: (key) => timers.delete(key),
  });
  t.after(() => controller.dispose());
  return {
    controller, timers,
    get component() { return component; },
    get registered() { return registered; },
    declare(value) { cleanup?.(); cleanup = value ? install() : null; },
    async runTimer() {
      const [key, { callback, delay }] = timers.entries().next().value;
      timers.delete(key);
      await callback();
      return delay;
    },
  };
}

test('native leading slot uses the original Bot avatar by session id and refreshes without per-row reads', async (t) => {
  const bot = { id: 'ds-one', name: 'same name', color: 'red', avatar: { shape: 'whale' } };
  let entries = [{ sessionId: 'bound', bot }];
  let calls = 0;
  let fail = false;
  const f = fixture(t, async (endpoint, payload) => {
    calls++;
    assert.equal(endpoint, 'ds-bot.sessions.list');
    assert.deepEqual(payload, {});
    return fail ? { ok: false } : { ok: true, value: entries };
  });
  assert.equal(calls, 0, 'older Hosts with no leading slot do not poll');
  await act(async () => f.declare(true));
  let renderer;
  const render = () => React.createElement(React.Fragment, null,
    ...['bound', 'same-name-but-unbound', 'next'].map((sessionId) => (
      React.createElement(f.component, { key: sessionId, sessionId })
    )));
  await act(async () => { renderer = create(render()); });
  t.after(() => act(() => renderer.unmount()));
  const avatars = () => renderer.root.findAllByType(DsBotAvatar);
  assert.equal(calls, 1);
  assert.equal(avatars().length, 1);
  assert.deepEqual(avatars()[0].props, { bot, size: 16 });
  assert.equal([...f.timers.values()][0].delay, 30_000);
  entries = [{ sessionId: 'next', bot: { ...bot, color: 'violet' } }];
  await act(async () => { f.controller.refresh(); assert.equal(await f.runTimer(), 0); });
  assert.equal(avatars().length, 1);
  assert.equal(avatars()[0].parent.props.sessionId, 'next');
  assert.equal(avatars()[0].props.bot.color, 'violet');
  fail = true;
  await act(async () => { await f.runTimer(); });
  assert.equal(avatars().length, 0, 'an unavailable provider must not retain stale avatars');
  fail = false;
  await act(async () => { await f.runTimer(); });
  assert.equal(avatars().length, 1);
  entries = [];
  await act(async () => { f.controller.refresh(); await f.runTimer(); });
  assert.equal(avatars().length, 0, 'unbind releases the leading icon');
  act(() => { renderer.unmount(); f.declare(false); });
  assert.equal(f.registered, false);
  assert.equal(f.timers.size, 0);
  await act(async () => { f.declare(true); renderer = create(render()); });
  assert.equal(f.registered, true, 'slot re-declaration installs one fresh subscription');
});

test('refresh discards in-flight stale binding data and disposal aborts pending reads', async (t) => {
  const pending = [];
  let signal;
  const f = fixture(t, (endpoint, payload, currentSignal) => {
    signal = currentSignal;
    const result = Promise.withResolvers();
    pending.push(result);
    return result.promise;
  });
  f.declare(true);
  let renderer;
  act(() => { renderer = create(React.createElement(f.component, { sessionId: 'bound' })); });
  t.after(() => act(() => renderer.unmount()));
  f.controller.refresh();
  f.controller.refresh();
  assert.equal(pending.length, 1, 'refreshes coalesce while a read is pending');
  await act(async () => pending[0].resolve({ ok: true, value: [{ sessionId: 'bound', bot: { id: 'old' } }] }));
  assert.equal(renderer.toJSON(), null);
  assert.equal([...f.timers.values()][0].delay, 0);
  const loading = f.runTimer();
  assert.equal(pending.length, 2);
  f.controller.dispose();
  assert.equal(signal.aborted, true);
  await act(async () => { pending[1].resolve({ ok: true, value: [] }); await loading; });
  assert.equal(f.timers.size, 0);
  assert.equal(f.registered, false);
});
