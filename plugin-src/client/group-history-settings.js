import * as React from 'react';
import { h } from './i18n.js';

export const GROUP_HISTORY_SETTINGS_ENDPOINTS = Object.freeze({
  get: 'settings.group-history.get', set: 'settings.group-history.set',
});

function result(value) {
  if (value?.ok === false) throw new Error(value.error?.message || '无法读取或保存群记录设置，请稍后重试。');
  return value?.ok === true ? value.value : value;
}

export function GroupHistorySettings({ rpcCall }) {
  const [days, setDays] = React.useState('14');
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const mounted = React.useRef(false);
  const busy = React.useRef(false);
  const id = React.useId();
  const load = React.useCallback(async (signal) => {
    setPhase('loading'); setError(null);
    try {
      const settings = result(await rpcCall(GROUP_HISTORY_SETTINGS_ENDPOINTS.get, {}, signal));
      if (signal?.aborted || !mounted.current) return;
      if (!Number.isSafeInteger(settings?.groupHistoryRetentionDays)) throw new Error('群记录设置返回了无法识别的响应。');
      setDays(String(settings.groupHistoryRetentionDays));
      setError(settings.error ?? null); setPhase('ready');
    } catch (caught) {
      if (signal?.aborted || !mounted.current) return;
      setError(caught.message); setPhase('error');
    }
  }, [rpcCall]);
  React.useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [load]);

  const save = async (event) => {
    event.preventDefault();
    if (busy.current || phase !== 'ready') return;
    const value = Number(days);
    if (!/^\d+$/.test(days.trim()) || !Number.isSafeInteger(value) || value < 1 || !Number.isSafeInteger(value * 86400000)) {
      setError('保留天数必须为正整数。'); return;
    }
    busy.current = true; setPhase('saving'); setError(null); setNotice(null);
    try {
      const settings = result(await rpcCall(GROUP_HISTORY_SETTINGS_ENDPOINTS.set, { groupHistoryRetentionDays: value }));
      if (mounted.current) { setDays(String(settings.groupHistoryRetentionDays)); setNotice('已保存'); }
    } catch (caught) { if (mounted.current) setError(caught.message); }
    finally { busy.current = false; if (mounted.current) setPhase('ready'); }
  };
  return h('section', { className: 'dim-globalSection dim-groupHistorySettings', 'aria-label': '群聊天记录', 'aria-busy': phase === 'loading' },
    h('h3', null, '群聊天记录保留天数'),
    h('p', { className: 'dim-globalInline' }, '自动保存实际收到的群消息及其附件，按群共享，默认保留最近 14 天。修改后对所有群生效。'),
    h('form', { className: 'dim-globalTtlRow', onSubmit: save },
      h('label', { htmlFor: `${id}-days` }, '保留天数'),
      h('input', { id: `${id}-days`, className: 'dim-globalTtlInput', type: 'number', min: 1, step: 1,
        value: days, disabled: phase !== 'ready',
        onChange: (event) => { setDays(event.target.value); setNotice(null); } }),
      h('span', null, '天'),
      h('button', { type: 'submit', className: 'dim-deliveryButton dim-globalSaveButton', 'data-kind': 'primary',
        disabled: phase !== 'ready' }, phase === 'saving' ? '保存中…' : '保存')),
    h('p', { className: 'dim-globalInline' }, '缩短保留天数会清理过期记录及其群文件；调大天数不会恢复已删除内容。会话中已有的副本按原有规则保留。'),
    phase === 'loading' ? h('p', { role: 'status', className: 'dim-globalInline' }, '正在读取群记录设置…') : null,
    error ? h('p', { role: 'alert', className: 'dim-globalInline', 'data-tone': 'error' }, error) : null,
    notice ? h('p', { role: 'status', className: 'dim-globalInline' }, notice) : null);
}
