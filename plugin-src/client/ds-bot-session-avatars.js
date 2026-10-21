import * as React from 'react';
import { DsBotAvatar } from './ds-bot-avatar.js';

export const DS_BOT_SESSIONS_ENDPOINT = 'ds-bot.sessions.list';

/** Use the Host's leading-icon slot, before the existing channel/title display.
 * One shared read covers every row; no title matching or per-row requests. */
export function installDsBotSessionAvatars(ctx, {
  rpcCall, setTimeoutFn = globalThis.setTimeout, clearTimeoutFn = globalThis.clearTimeout,
  pollMs = 30_000,
}) {
  let refresh = () => {};
  const stop = ctx.slots.inject('sidebar.session.row.leading', () => {
    const abort = new AbortController();
    const listeners = new Set();
    let bots = new Map();
    let signature = '';
    let timer;
    let running = false;
    let revision = 0;
    const publish = (entries) => {
      const next = JSON.stringify(entries);
      if (next === signature) return;
      signature = next;
      bots = new Map(entries.map(({ sessionId, bot }) => [sessionId, bot]));
      for (const listener of listeners) listener();
    };
    const subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    function SessionAvatar({ sessionId }) {
      const bot = React.useSyncExternalStore(subscribe, () => bots.get(sessionId) ?? null);
      return bot ? React.createElement(DsBotAvatar, { bot, size: 16 }) : null;
    }
    const schedule = (delay) => {
      clearTimeoutFn(timer);
      if (!abort.signal.aborted) timer = setTimeoutFn(load, delay);
    };
    const load = async () => {
      if (abort.signal.aborted || running) return;
      running = true;
      const current = revision;
      try {
        const result = await rpcCall(DS_BOT_SESSIONS_ENDPOINT, {}, abort.signal);
        if (result?.ok !== true || !Array.isArray(result.value)) throw new Error('Unavailable');
        if (!abort.signal.aborted && current === revision) publish(result.value);
      } catch {
        if (!abort.signal.aborted && current === revision) publish([]);
      } finally {
        running = false;
        schedule(current === revision ? pollMs : 0);
      }
    };
    refresh = () => {
      revision++;
      if (!running) schedule(0);
    };
    const unregister = ctx.slots.register({
      name: 'sidebar.session.row.leading', id: 'dsh-im-ds-bot-avatar', order: 0,
    }, SessionAvatar);
    void load();
    return () => {
      abort.abort();
      clearTimeoutFn(timer);
      refresh = () => {};
      unregister();
      listeners.clear();
    };
  });
  return { refresh: () => refresh(), dispose: stop };
}
