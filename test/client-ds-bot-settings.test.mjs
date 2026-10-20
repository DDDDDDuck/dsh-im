import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { DsBotSettingsPage, DsBotPicker } from '../plugin-src/client/ds-bot-settings.js';
import { DsBotAvatar } from '../plugin-src/client/ds-bot-avatar.js';

const { act, create } = TestRenderer;
const bots = [
  { id: 'ds-one', name: 'stepBot', color: 'red', avatar: { shape: 'whale' } },
  { id: 'ds-two', name: 'ImBot', color: 'violet', avatar: { shape: 'whale' } },
];
const key = 'c2c:private-one';
function text(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node?.props?.children ?? '');
}

test('binding page works without any delivery RPC and renders avatars in the picker and bound row', async (t) => {
  let binding;
  const calls = [];
  let renderer;
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'ds-bot.bind') binding = payload.dsBotId;
    else if (endpoint === 'ds-bot.unbind') binding = undefined;
    else assert.equal(endpoint, 'ds-bot.status');
    return { state: 'ready', bots, conversations: [{ conversationKey: key, address: 'private-one', dsBotId: binding }] };
  };
  await act(async () => { renderer = create(React.createElement(DsBotSettingsPage, { botId: 'im-one', rpcCall })); });
  t.after(async () => act(async () => renderer.unmount()));
  assert.equal(renderer.root.findAllByType('select').length, 1);
  assert.equal(renderer.root.findAllByProps({ role: 'combobox' }).length, 1);
  await act(async () => renderer.root.findByProps({ role: 'combobox' }).props.onClick());
  const options = renderer.root.findAllByProps({ role: 'option' });
  assert.equal(options.length, 2);
  assert.equal(options[0].findAllByType(DsBotAvatar).length, 1);
  await act(async () => options[0].props.onClick());
  await act(async () => renderer.root.findByType('select').props.onChange({ target: { value: key } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(calls.find((call) => call.endpoint === 'ds-bot.bind').payload, {
    botId: 'im-one', dsBotId: 'ds-one', conversationKey: key,
  });
  const row = renderer.root.findByType('li');
  assert.equal(row.findByType(DsBotAvatar).props.bot.name, 'stepBot');
  assert.match(text(row), /stepBot.*已绑定.*private-one/);
  await act(async () => row.findByType('button').props.onClick());
  assert.equal(renderer.root.findAllByType('li').length, 0);
  assert.equal(calls.every((call) => call.endpoint.startsWith('ds-bot.')), true);
});

test('empty private chats show one instruction, with no dependency on delivery settings', async () => {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DsBotSettingsPage, {
      botId: 'im-one', rpcCall: async () => ({ state: 'ready', bots, conversations: [] }),
    }));
  });
  assert.match(text(renderer.root.findByType('section')), /先给这个机器人发一条私聊消息/);
  assert.doesNotMatch(text(renderer.root.findByType('section')), /投递设置/);
  await act(async () => renderer.unmount());
});

test('the avatar picker supports keyboard selection and escape', async () => {
  let renderer;
  let selected;
  await act(async () => { renderer = create(React.createElement(DsBotPicker, {
    bots, value: '', onChange: (id) => { selected = id; },
  })); });
  const keyDown = async (key) => act(async () => renderer.root.findByProps({ role: 'combobox' })
    .props.onKeyDown({ key, preventDefault() {} }));
  await keyDown('ArrowDown');
  await keyDown('ArrowDown');
  await keyDown('Enter');
  assert.equal(selected, 'ds-two');
  assert.equal(renderer.root.findAllByProps({ role: 'listbox' }).length, 0);
  await keyDown('ArrowDown');
  await keyDown('Escape');
  assert.equal(renderer.root.findAllByProps({ role: 'listbox' }).length, 0);
  await act(async () => renderer.unmount());
});

test('avatar uses DS Bot colors and shapes or its safe uploaded raster image', () => {
  const whale = renderToStaticMarkup(React.createElement(DsBotAvatar, { bot: bots[0] }));
  assert.match(whale, /#FF3E51/);
  assert.match(whale, /<mask/);
  const photo = renderToStaticMarkup(React.createElement(DsBotAvatar, {
    bot: { avatar: { image: 'data:image/png;base64,AAAA' } },
  }));
  assert.match(photo, /<img/);
  const unsafe = renderToStaticMarkup(React.createElement(DsBotAvatar, {
    bot: { avatar: { image: 'https://untrusted.example/track' } },
  }));
  assert.doesNotMatch(unsafe, /untrusted/);
  assert.match(renderToStaticMarkup(React.createElement(DsBotAvatar, {
    bot: { id: 'unknown-shape', color: 'constructor', avatar: { shape: 'constructor' } },
  })), /<svg/);
});
