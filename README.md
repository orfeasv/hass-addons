# Home Assistant Add-ons

Custom add-ons for Home Assistant.

## Installation

Add this repository to Home Assistant:

1. Go to **Settings** → **Add-ons** → **Add-on Store**
2. Click menu (⋮) → **Repositories**
3. Add: `https://github.com/orfeasv/hass-addons`
4. Install add-ons from the store

## Add-ons

### iPerf3 Server

Network performance testing server. Run bandwidth tests directly from your Home Assistant instance.

**Features:**
- TCP and UDP support
- Configurable port
- Verbose logging option

[Documentation →](./iperf3-server/README.md)

### TV Box Remote

Remote control for Android TV boxes and TVs over authenticated adb, in the sidebar and in the Home Assistant app on iPhone and Android.

**Features:**
- D-pad, Home, Back, Menu, volume, Sleep/Wake and typing
- Several boxes, picked with one tap; finds them on the network
- Uses Ethernet or Wi-Fi, whichever is up, and finds a box again after DHCP moves it
- Android TV Remote for Google TV / Android TV devices paired in Home Assistant, with adb as fallback
- API for dashboard buttons, scripts and automations

[Documentation →](./tvbox-remote/DOCS.md)

## Support

For issues, check the add-on logs or open an issue in this repository.