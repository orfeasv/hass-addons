# Changelog

## 0.2.0

- Android TV Remote: a box can be linked to its pairing in Home Assistant's Android TV Remote integration;
  keys then go out as `remote.send_command`, with adb as the fallback when it's unavailable

## 0.1.0

- Remote page in the sidebar: D-pad, OK, Back, Home, Menu, volume, mute, Sleep, Wake, typing
- Several boxes: tabs to switch, network scan to find them, rename and remove
- Keys go through each box's own remote input device and key layout, found automatically
- Ethernet and Wi-Fi per box: picks the link that answers, checks the serial, finds a box again by MAC
  after DHCP moves it
- API for dashboards, scripts and automations (`rest_command`)
- Authenticated adb with its own key, approved once on each TV
