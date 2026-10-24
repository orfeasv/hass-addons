import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { HomeAssistant, homeAssistantFromEnv } from '../src/ha.js';
import { makeBoxes } from './fakes.js';

/** Home Assistant stand-in: entity states and the remote.send_command calls it received. */
function fakeHa(states = { 'remote.living_room_tv': 'on' }) {
  const calls = [];
  const fetchFn = async (url, { method, headers, body }) => {
    assert.equal(headers.Authorization, 'Bearer T');
    const path = new URL(url).pathname;
    const json = (data, ok = true) => ({ ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'Error', json: async () => data });
    if (method === 'GET' && path === '/api/states') {
      return json(Object.entries(states).map(([entity_id, state]) => ({ entity_id, state, attributes: { friendly_name: `TV ${entity_id}` } })));
    }
    if (method === 'GET' && path.startsWith('/api/states/')) return json({ state: states[decodeURIComponent(path.slice(12))] ?? 'unavailable' });
    if (method === 'POST' && path === '/api/services/remote/send_command') {
      calls.push(JSON.parse(body));
      return json([], !fakeHa.failNext);
    }
    return json({}, false);
  };
  return { ha: new HomeAssistant({ url: 'http://ha:8123/', token: 'T', fetch: fetchFn }), calls, states };
}

test('the Supervisor token wins; without any token the API is off', () => {
  assert.equal(homeAssistantFromEnv({ SUPERVISOR_TOKEN: 's', HA_URL: 'x', HA_TOKEN: 't' }).url, 'http://supervisor/core');
  assert.equal(homeAssistantFromEnv({ HA_URL: 'http://ha:8123', HA_TOKEN: 't' }).enabled, true);
  assert.equal(homeAssistantFromEnv({}).enabled, false);
});

test('lists remote entities only', async () => {
  const { ha } = fakeHa({ 'remote.living_room_tv': 'on', 'light.kitchen': 'off' });
  assert.deepEqual(await ha.remotes(), [{ entity: 'remote.living_room_tv', name: 'TV remote.living_room_tv', state: 'on' }]);
});

test('a linked box sends keys through Android TV Remote, and adb when it is unavailable', async () => {
  const { ha, calls, states } = fakeHa();
  const boxes = makeBoxes();
  boxes.ha = ha;
  const box = boxes.add({ host: '10.0.0.6' });
  await tick();
  boxes.update(box.id, { entity: 'remote.living_room_tv' });

  await box.remote.press('ok');
  assert.deepEqual(calls, [{ entity_id: 'remote.living_room_tv', command: 'DPAD_CENTER' }]);
  assert.equal(boxes.view(box).route, 'atv');

  states['remote.living_room_tv'] = 'unavailable';
  ha.states.clear(); // skip the availability cache
  await box.remote.press('home');
  assert.equal(calls.length, 1);
  assert.equal(boxes.view(box).route, 'adb');
  assert.match(box.link.client.commands.at(-1), /^dd if=.*\/102\.ev/);
});

test('a failed Android TV Remote call falls back to adb', async () => {
  const { ha } = fakeHa();
  const boxes = makeBoxes();
  boxes.ha = ha;
  const box = boxes.add({ host: '10.0.0.6' });
  await tick();
  boxes.update(box.id, { entity: 'remote.living_room_tv' });
  fakeHa.failNext = true;
  try {
    await box.remote.press('back');
  } finally {
    fakeHa.failNext = false;
  }
  assert.equal(box.remote.route, 'adb');
  assert.match(box.link.client.commands.at(-1), /\/158\.ev/);
});

test('linking checks the entity id; null unlinks', async () => {
  const boxes = makeBoxes();
  const box = boxes.add({ host: '10.0.0.5' });
  assert.throws(() => boxes.update(box.id, { entity: 'light.kitchen' }), RangeError);
  boxes.update(box.id, { entity: 'remote.tv' });
  assert.equal(box.record.entity, 'remote.tv');
  boxes.update(box.id, { entity: null });
  assert.equal(box.record.entity, null);
});
