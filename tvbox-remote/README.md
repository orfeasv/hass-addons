# TV Box Remote

A remote control for Android TV boxes and TVs, in the Home Assistant sidebar and in the Home Assistant app on iPhone and Android.

- D-pad, OK, Back, Home, Menu, volume, mute, digits
- Sleep and Wake
- Type text into the box's search fields from the phone keyboard
- Several boxes: found with a network scan, switched with one tap
- Android TV Remote for Google TV / Android TV devices paired in Home Assistant, with adb as fallback
- Installable as its own app (Chrome) over https with Home Assistant's certificate
- An API, so dashboard buttons, scripts and automations can press keys

It talks to each box over the network with authenticated adb. Nothing is installed on the box.

See the Documentation tab for setup.
