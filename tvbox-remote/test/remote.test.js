import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyPressBytes, mapKeys, parseCapabilities, parseInputDevices, parseKeyLayout, Remote } from '../src/remote.js';

// Trimmed real output from an RK3566 box
const DUMPSYS = `Event Hub State:
  BuiltInKeyboardId: -2
  Devices:
    -1: Virtual
      Path: <virtual>
      KeyLayoutFile: /system/usr/keylayout/Generic.kl
    2: Logitech USB Receiver
      Path: /dev/input/event3
      KeyLayoutFile: /system/usr/keylayout/Generic.kl
    3: Logitech USB Receiver Mouse
      Path: /dev/input/event4
      KeyLayoutFile:
    6: fdd70030.pwm
      Path: /dev/input/event0
      KeyLayoutFile: /data/system/devices/keylayout/Vendor_524b_Product_0006_Version_0100.kl
Input Reader State:
    6: ignored
      Path: /dev/input/event9
      KeyLayoutFile: /x.kl
`;

const IR_KL = `# volume swapped by an override
key 28    ENTER
key 116   POWER
key 158   BACK
key 139   MENU
key 108   DPAD_DOWN
key 103   DPAD_UP
key 102   HOME
key 105   DPAD_LEFT
key 106   DPAD_RIGHT
key 115   VOLUME_DOWN
key 114   VOLUME_UP
key 113   VOLUME_MUTE
key 401   HOME
key 2     1
key usage 0x0c0067 WINDOW
`;
const IR_CAPS = `add device 1: /dev/input/event0
  name:     "fdd70030.pwm"
  events:
    KEY (0001): 0002  0003  001c  0066  0067  0069  006a
                006c  0071  0072  0073  0074  008b  009e
  input props:
    <none>`;

const GENERIC_KL = 'key 103 DPAD_UP\nkey 108 DPAD_DOWN\nkey 105 DPAD_LEFT\nkey 106 DPAD_RIGHT\nkey 28 ENTER\nkey 1 ESCAPE\n';
const KEYBOARD_CAPS = 'add device 1: /dev/input/event3\n  events:\n    KEY (0001): 001c  0067  0069  006a  006c\n  input props:\n    <none>';

/** Box stand-in answering the discovery commands; `writable` lists device paths the shell may write. */
function fakeBox({ writable = ['/dev/input/event0', '/dev/input/event3'], dumpsys = DUMPSYS } = {}) {
  return {
    connected: true, banner: 'device::', commands: [],
    async shell(cmd) {
      this.commands.push(cmd);
      if (cmd === 'dumpsys input') return dumpsys;
      const path = cmd.match(/^test -w (\S+)/)?.[1];
      if (path) {
        if (!writable.includes(path)) return '';
        return path === '/dev/input/event0' ? `${IR_KL}==CAPS==\n${IR_CAPS}` : `${GENERIC_KL}==CAPS==\n${KEYBOARD_CAPS}`;
      }
      return '';
    },
  };
}

test('a key press is down, sync, up, sync in 96 bytes', () => {
  const bytes = keyPressBytes(103);
  assert.equal(bytes.length, 96);
  const events = [0, 24, 48, 72].map((o) => [bytes.readUInt16LE(o + 16), bytes.readUInt16LE(o + 18), bytes.readInt32LE(o + 20)]);
  assert.deepEqual(events, [[1, 103, 1], [0, 0, 0], [1, 103, 0], [0, 0, 0]]);
});

test('input devices come from the Event Hub section only, with a path and a layout', () => {
  assert.deepEqual(parseInputDevices(DUMPSYS).map((d) => d.name), ['Logitech USB Receiver', 'fdd70030.pwm']);
});

test('keys map through the layout to codes the device declares', () => {
  const codes = mapKeys(parseKeyLayout(IR_KL), parseCapabilities(IR_CAPS));
  assert.equal(codes.volume_up, 114); // the override's mapping, not the kernel's usual 115
  assert.equal(codes.ok, 28); // ENTER, as no DPAD_CENTER is mapped
  assert.equal(codes.home, 102); // first HOME line; 401 is not declared anyway
  assert.equal(codes['1'], 2);
  assert.equal(codes.sleep, undefined); // always through input keyevent
  assert.equal(codes['5'], undefined); // not in the layout
});

test('the remote device wins over a keyboard, unmapped keys fall back to input keyevent', async () => {
  const adb = fakeBox();
  const remote = new Remote({ adb });
  await remote.press('up');
  assert.equal(remote.device.path, '/dev/input/event0');
  assert.match(adb.commands.at(-1), /^dd if=\/data\/local\/tmp\/tvremote\/103\.ev of=\/dev\/input\/event0 bs=96/);
  await remote.press('5');
  assert.equal(adb.commands.at(-1), 'input keyevent KEYCODE_5');
  await remote.press('sleep');
  assert.equal(adb.commands.at(-1), 'input keyevent KEYCODE_SLEEP');
  await assert.rejects(remote.press('rm -rf'), RangeError);
  assert.equal(adb.commands.filter((c) => c === 'dumpsys input').length, 1); // examined once per connection
});

test('without a writable device every key uses input keyevent', async () => {
  const adb = fakeBox({ writable: [] });
  const remote = new Remote({ adb });
  await remote.press('ok');
  assert.equal(remote.device, null);
  assert.equal(adb.commands.at(-1), 'input keyevent KEYCODE_DPAD_CENTER');
});

test('typed text is quoted for the shell', async () => {
  const adb = fakeBox();
  await new Remote({ adb }).type("it's a test; reboot");
  assert.equal(adb.commands[0], `input text 'it'\\''s%sa%stest;%sreboot'`);
});
