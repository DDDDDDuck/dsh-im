import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { SidebarSettings, installSidebarVisibilitySync } from '../plugin-src/client/sidebar-settings.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const result = (mode, visible) => ({ ok: true, value: { mode, visible } });

test('sidebar settings load, save all modes, retain edits on failure, and retry load', async (t) => {
  let fail = true;
  const calls = [];
  let renderer;
  const rpcCall = async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (fail) return { ok: false, error: { message: '无法保存' } };
    return result(payload.mode ?? 'auto', payload.mode === 'show');
  };
  t.after(() => act(() => renderer.unmount()));
  await act(async () => { renderer = create(React.createElement(SidebarSettings, { rpcCall })); });
  assert.equal(renderer.root.findByType('select').props.disabled, true);
  fail = false;
  await act(async () => renderer.root.findAllByType('button').find((button) => button.props.type === 'button').props.onClick());
  const select = () => renderer.root.findByType('select');
  assert.equal(select().props.value, 'auto');
  assert.deepEqual(select().findAllByType('option').map((option) => option.props.value), ['auto', 'show', 'hide']);
  for (const mode of ['show', 'hide', 'auto']) {
    await act(async () => select().props.onChange({ target: { value: mode } }));
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.deepEqual(calls.at(-1), ['settings.sidebar-entry.set', { mode }]);
    assert.equal(renderer.root.findByProps({ role: 'status' }).children.join(''), '已保存');
  }
  fail = true;
  await act(async () => select().props.onChange({ target: { value: 'hide' } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(select().props.value, 'hide');
  assert.equal(select().props.disabled, false);
  assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), '无法保存');
});

function syncHarness(t) {
  const calls = [];
  const visible = [];
  const timers = new Map();
  let id = 0;
  const sync = installSidebarVisibilitySync({
    rpcCall: (_endpoint, _payload, signal) => new Promise((resolve, reject) => calls.push({ resolve, reject, signal })),
    setVisible: (value) => visible.push(value),
    setTimeoutFn(callback, delay) { timers.set(++id, { callback, delay }); return id; },
    clearTimeoutFn(timer) { timers.delete(timer); },
  });
  t.after(() => sync.dispose());
  return { sync, calls, visible, timers, tick() {
    const [key, timer] = timers.entries().next().value;
    timers.delete(key); timer.callback();
  } };
}

test('visibility sync applies startup and cross-client changes and retains visibility on failure', async (t) => {
  const host = syncHarness(t);
  host.calls[0].resolve(result('auto', false));
  await flush();
  assert.deepEqual(host.visible, [false]);
  assert.equal([...host.timers.values()][0].delay, 30_000);
  host.tick(); host.calls[1].resolve(result('auto', true)); await flush();
  assert.deepEqual(host.visible, [false, true]);
  host.sync.refresh(); host.tick(); host.calls[2].reject(Error('offline')); await flush();
  assert.deepEqual(host.visible, [false, true]);
  host.tick(); host.calls[3].resolve({ ok: false }); await flush();
  assert.deepEqual(host.visible, [false, true]);
});

test('in-flight reads cannot undo a saved preference or resurrect an unmounted entry', async (t) => {
  const host = syncHarness(t);
  host.sync.apply(result('hide', false));
  host.calls[0].resolve(result('auto', true)); await flush();
  assert.deepEqual(host.visible, [false]);
  host.tick();
  host.sync.refresh(); host.sync.refresh();
  host.calls[1].resolve(result('auto', true)); await flush();
  assert.deepEqual(host.visible, [false], 'read predating channel mutation is stale');
  host.tick(); host.calls[2].resolve(result('auto', false)); await flush();
  assert.deepEqual(host.visible, [false, false]);
  host.tick(); host.sync.dispose();
  assert.equal(host.calls[3].signal.aborted, true);
  host.calls[3].resolve(result('show', true)); await flush();
  assert.deepEqual(host.visible, [false, false]);
  assert.equal(host.timers.size, 0);
});
