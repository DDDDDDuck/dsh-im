import * as React from 'react';
import { h } from './i18n.js';

export const GROUP_HISTORY_SETTINGS_ENDPOINTS = Object.freeze({
  get: 'settings.group-history.get', set: 'settings.group-history.set',
  groups: 'settings.group-history.groups', enable: 'settings.group-history.enable',
});

const CHANNELS = { whatsapp: 'WhatsApp', feishu: '飞书', telegram: 'Telegram', discord: 'Discord', slack: 'Slack', qq: 'QQ' };

function result(value) {
  if (value?.ok === false) throw new Error(value.error?.message || '无法读取或保存群记录设置，请稍后重试。');
  return value?.ok === true ? value.value : value;
}

export function GroupHistorySettings({ rpcCall }) {
  const [days, setDays] = React.useState('14');
  const [groups, setGroups] = React.useState([]);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [savingGroup, setSavingGroup] = React.useState(null);
  const mounted = React.useRef(false);
  const busy = React.useRef(false);
  const id = React.useId();
  const load = React.useCallback(async (signal) => {
    setPhase('loading'); setError(null);
    try {
      const [settings, list] = await Promise.all([
        rpcCall(GROUP_HISTORY_SETTINGS_ENDPOINTS.get, {}, signal).then(result),
        rpcCall(GROUP_HISTORY_SETTINGS_ENDPOINTS.groups, {}, signal).then(result),
      ]);
      if (signal?.aborted || !mounted.current) return;
      if (!Number.isSafeInteger(settings?.groupHistoryRetentionDays) || !Array.isArray(list?.groups)) throw new Error('群记录设置返回了无法识别的响应。');
      setDays(String(settings.groupHistoryRetentionDays)); setGroups(list.groups);
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
  const toggle = async (group) => {
    if (busy.current || phase !== 'ready') return;
    busy.current = true; setSavingGroup(group.id); setError(null); setNotice(null);
    try {
      const saved = result(await rpcCall(GROUP_HISTORY_SETTINGS_ENDPOINTS.enable, { groupId: group.id, enabled: !group.enabled }));
      if (mounted.current) setGroups((items) => items.map((item) => item.id === group.id ? { ...item, enabled: saved.enabled } : item));
    } catch (caught) { if (mounted.current) setError(caught.message); }
    finally { busy.current = false; if (mounted.current) setSavingGroup(null); }
  };
  return h('section', { className: 'dim-globalSection dim-groupHistorySettings', 'aria-label': '群聊天记录', 'aria-busy': phase === 'loading' },
    h('h3', null, '群聊天记录保留天数'),
    h('p', { className: 'dim-globalInline' }, '按群共享聊天记录及其附件，默认保留最近 14 天。修改后对所有启用采集的群生效。'),
    h('form', { className: 'dim-globalTtlRow', onSubmit: save },
      h('label', { htmlFor: `${id}-days` }, '保留天数'),
      h('input', { id: `${id}-days`, className: 'dim-globalTtlInput', type: 'number', min: 1, step: 1,
        value: days, disabled: phase !== 'ready' || savingGroup !== null,
        onChange: (event) => { setDays(event.target.value); setNotice(null); } }),
      h('span', null, '天'),
      h('button', { type: 'submit', className: 'dim-deliveryButton dim-globalSaveButton', 'data-kind': 'primary',
        disabled: phase !== 'ready' || savingGroup !== null }, phase === 'saving' ? '保存中…' : '保存')),
    h('p', { className: 'dim-globalInline' }, '缩短保留天数会清理过期记录及其群文件；调大天数不会恢复已删除内容。会话中已有的副本按原有规则保留。'),
    h('div', { className: 'dim-globalHead' }, h('h3', null, '群记录采集'),
      h('button', { type: 'button', className: 'dim-deliveryButton', disabled: phase === 'loading' || phase === 'saving' || savingGroup !== null,
        onClick: () => void load() }, '刷新')),
    h('p', { className: 'dim-globalInline' }, '先在目标群内 @ 机器人，再刷新列表并开启采集。开启后保存实际收到的普通消息和文件，不改变机器人的回复方式。'),
    !groups.length && phase !== 'loading' ? h('p', { className: 'dim-globalInline' }, '暂无已发现的群') : null,
    h('div', { className: 'dim-groupHistoryList' }, ...groups.map((group) => h('div', { className: 'dim-groupHistoryRow', key: group.id },
      h('div', { className: 'dim-groupHistoryDetails' },
        h('strong', null, group.name),
        h('small', null, `${CHANNELS[group.channel] ?? group.channel} · ${group.platformGroupId}`),
        group.capability ? h('small', null, group.capability) : null,
        h('small', null, `已保存消息：${group.messageCount}`)),
      h('button', { type: 'button', className: 'dim-deliveryButton', role: 'switch', 'aria-checked': group.enabled,
        'aria-label': `${group.name}的群记录采集`, disabled: phase !== 'ready' || savingGroup !== null,
        onClick: () => void toggle(group) }, savingGroup === group.id ? '保存中…' : group.enabled ? '已开启' : '开启采集')))),
    phase === 'loading' ? h('p', { role: 'status', className: 'dim-globalInline' }, '正在读取群记录设置…') : null,
    error ? h('p', { role: 'alert', className: 'dim-globalInline', 'data-tone': 'error' }, error) : null,
    notice ? h('p', { role: 'status', className: 'dim-globalInline' }, notice) : null);
}
