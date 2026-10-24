# TV Box Remote

## How it works

The add-on connects to each box's adb daemon over the network (TCP 5555) with its own RSA key, like a computer running `adb connect`. Nothing is installed on the box.

When it first talks to a box, it reads the box's input devices (`dumpsys input`) and picks the one whose key layout covers the remote's keys, usually the box's own IR-remote receiver. Key presses are written straight into that device, so Android handles them exactly like the physical remote, in about 150 ms from the button. Keys that device can't send, and Sleep, Wake and typed text, go through Android's `input` command, which takes about a second. Event files for the fast keys are kept on the box in `/data/local/tmp/tvremote/`.

### Ethernet, Wi-Fi and changing addresses

A box is one device, recognised by its serial number, with a link per network interface. After each connection the add-on records the serial and each interface's MAC address and current IP address (in `/data/boxes.json`). It connects over the address that worked last, otherwise Ethernet before Wi-Fi, and checks the serial each time, so a different device that got the box's old address is never controlled. When none of the known addresses answers (DHCP gave the box a new one), it looks the box's MAC addresses up in the host's ARP table, and if they aren't there yet, scans the network to fill it and looks again. If the connection drops in the middle of a command, it finds the box again, over the other link if needed, and retries once.

One key covers every link: the box trusts the add-on's key itself, whichever interface the connection comes in on. Adding the same box a second time (for example its Wi-Fi address from a scan) merges it into the existing entry once its serial is read.

## Requirements on each box

- adb over the network on port 5555. Authentication on (`ro.adb.secure=1`) is recommended; the add-on supports both.
- A DHCP reservation helps but isn't needed: a moved box is found by its MAC address.

## Adding a box

1. Open **TV Box** in the sidebar and choose **＋** (with no box yet, this opens by itself).
2. **Find boxes on the network** lists every device with adb on port 5555, or type the address yourself.
3. Choose **Add**. On a box with authentication on, the TV shows **"Allow USB debugging?"** with the key's fingerprint: tick **Always allow from this computer** and choose **Allow**. The page shows "Waiting for approval on the TV" until then.

On first start the add-on creates its key in `/data/adbkey.pem` (kept across restarts and updates); every box trusts the same key.

Boxes appear as tabs at the top: one tap switches which box the remote controls, and the dot shows its connection (green connected, amber waiting for approval, grey not connected). Each phone or browser remembers the box it used last. **⋯** renames or removes the selected box.

To revoke the add-on on a box: Settings → System → Developer options → Revoke USB debugging authorizations (this revokes every computer), or remove its line (`… tvbox-remote@homeassistant`) from `/data/misc/adb/adb_keys`. `GET api/status` returns the add-on's public key in that format.

## Android TV Remote (Google TV and Android TV devices)

Devices running Android TV or Google TV also speak the Android TV Remote protocol (the one the Google TV app uses, ports 6466/6467). Boxes running a phone or tablet build of Android don't have it and use adb only.

1. Pair the device in Home Assistant: Settings → Devices & services → Add integration → **Android TV Remote**, then enter the code the TV shows. This creates a `remote.…` entity.
2. In TV Box, select the box, open **⋯** and pick that entity under **Android TV Remote**.

Keys for that box then go out as `remote.send_command` through Home Assistant's API (`homeassistant_api: true`). When the entity is unavailable or a call fails, the add-on uses adb for that key, so the box keeps working. Typing always uses adb. The status line shows "Keys via Android TV Remote" while that path is in use.

## Options

| Option | Default | Meaning |
|---|---|---|
| `host` | (none) | Optional: a box to add on first start. More are added on the remote page. |
| `port` | `5555` | adb port, for that box and for the network scan |

The add-on uses the host network (`host_network: true`): the scan needs the real home network, and the page and API are also reachable at `http://<home-assistant>:3400/`.

## Buttons in dashboards, scripts and automations

Keys: `up down left right ok back home menu volume_up volume_down mute backspace 0`–`9 sleep wake`.

| Request | Effect |
|---|---|
| `POST /api/boxes/<id>/key/<key>` | Presses a key on that box |
| `POST /api/boxes/<id>/text` with `{"text": "…"}` | Types text on that box |
| `POST /api/key/<key>` (optionally `?box=<id>`) | Short form: the first box, or the one given |
| `POST /api/text` (optionally `?box=<id>`) | Short form for typing |
| `GET /api/boxes` | The boxes, with their `id` and connection state |
| `PATCH /api/boxes/<id>` with `{"name": "…"}` and/or `{"entity": "remote.…"}` | Renames a box; links it to an Android TV Remote entity (`null` unlinks) |
| `GET /api/remotes` | Home Assistant's `remote.*` entities |

Add a `rest_command` in `configuration.yaml`:

```yaml
rest_command:
  tvbox_key:
    url: "http://localhost:3400/api/key/{{ key }}?box={{ box | default('') }}"
    method: post
  tvbox_text:
    url: "http://localhost:3400/api/text?box={{ box | default('') }}"
    method: post
    content_type: "application/json"
    payload: '{"text": {{ text | tojson }}}'
```

An empty `box` means the first box. A dashboard button:

```yaml
type: button
name: Living room TV Home
icon: mdi:home
tap_action:
  action: perform-action
  perform_action: rest_command.tvbox_key
  data:
    key: home
    box: 1a2b3c4d   # from GET /api/boxes
```

The same action works in scripts and automations (for example `key: sleep` at night), and in remote cards that take custom actions, such as Universal Remote Card.

## Notes

- There is no Power key: on some boxes the remote's Power shuts the box down instead of letting Android sleep. Sleep turns the screen off and keeps Android running; Wake brings it back.
- Boxes keep trusting the add-on's key after it is removed from the page, until revoked on the box.
