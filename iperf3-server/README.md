# iPerf3 Server Add-on

Network performance testing server for Home Assistant using iPerf3.

## Features

- Based on Alpine Linux
- Runs as non-root user
- Configurable port
- Support for TCP and UDP testing
- Multi-architecture support

## Installation

1. Copy this directory to your Home Assistant `/addons` folder
2. Refresh the add-on store
3. Install the "iPerf3 Server" add-on
4. Configure and start

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| port | int | 5201 | Server listening port |
| verbose | bool | false | Enable verbose logging |

## Testing

After starting the add-on, test from a client:
```bash
iperf3 -c <your-homeassistant-ip> -p 5201
```