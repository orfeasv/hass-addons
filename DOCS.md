# iPerf3 Server Add-on Documentation

This add-on runs an iPerf3 server for network performance testing.

## Configuration

**port** (integer, default: 5201)
- The port for the iPerf3 server to listen on

**verbose** (boolean, default: false)
- Enable verbose output in logs

## Usage

1. Install and start the add-on
2. From a client machine, run:
```bash
   iperf3 -c <homeassistant-ip> -p 5201
```

### Example Commands

**TCP test:**
```bash
iperf3 -c homeassistant.local -p 5201
```

**UDP test:**
```bash
iperf3 -c homeassistant.local -p 5201 -u -b 100M
```

**Reverse mode test:**
```bash
iperf3 -c homeassistant.local -p 5201 -R
```

## About iPerf3

iPerf3 is a tool for measuring maximum achievable bandwidth on IP networks. It supports:
- TCP and UDP protocols
- IPv4 and IPv6
- Bidirectional testing
- Multiple simultaneous connections

## Support

For issues, please check the add-on logs in Home Assistant.