# Zigbee2HASS
> [!WARNING]
***Important Note - This is incomplete and should not installed



**The reliable Zigbee integration for Home Assistant — powered by zigbee-herdsman. No MQTT required.**

[![HA Add-on](https://img.shields.io/badge/Home%20Assistant-Add--on-blue)](https://www.home-assistant.io/addons)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-bushrangerlabs%2Fzigbee2hass-black)](https://github.com/bushrangerlabs/zigbee2hass)

---

## Why Zigbee2HASS?

| Feature | ZHA | Zigbee2MQTT | **Zigbee2HASS** |
|---|---|---|---|
| No MQTT broker needed | ✅ | ❌ | ✅ |
| Process isolated from HA | ❌ | ✅ | ✅ |
| Command confirmation + retry | ❌ | ❌ | ✅ |
| State reconciliation on reconnect | ❌ | ❌ | ✅ |
| Coordinator watchdog | ❌ | ❌ | ✅ |
| Smart availability (ping mains, timeout battery) | ❌ | Partial | ✅ |
| Auto NVRam backup | ❌ | Manual | ✅ |
| Native HA entities (not MQTT sensors) | ✅ | Partial | ✅ |
| 4000+ devices (zigbee-herdsman-converters) | Partial | ✅ | ✅ |

---

## Architecture

```
[Zigbee USB Stick]
       ↓
[HA Add-on: Node.js + zigbee-herdsman]   ← process isolated, survives HA restarts
       ↓ WebSocket (localhost:8756)
[HA Custom Integration: Python]           ← native entities, proper HA platform
       ↓
[Home Assistant Entities]
```

---

## Installation

### Step 1 — Add the add-on repository

1. In HA, go to **Settings → Add-ons → Add-on Store**
2. Click the three-dot menu → **Repositories**
3. Add: `https://github.com/bushrangerlabs/zigbee2hass`

### Step 2 — Install and configure the add-on

1. Find **Zigbee2HASS** in the add-on store and install it
2. Configure your serial port and adapter type in the add-on configuration tab
3. Start the add-on

### Step 3 — Install the custom integration

1. Copy the `custom_components/zigbee2hass` folder to your HA `custom_components` directory
2. Restart Home Assistant
3. Go to **Settings → Integrations → Add Integration → Zigbee2HASS**
4. The add-on will be auto-discovered if running on the same machine

---

## Migrating from Zigbee2MQTT

You can import your existing Z2M devices — **no re-pairing needed**.

Call the service in HA Developer Tools:

```yaml
service: zigbee2hass.migrate_from_z2m
data:
  z2m_data_dir: /share/zigbee2mqtt
```

This imports:
- `coordinator_backup.json` — your entire paired device network
- `database.db` — device records and interview data
- Device friendly names from `configuration.yaml`

---

## Supported Hardware

### USB / Serial adapters

| Chip | Adapter | Status |
|---|---|---|
| CC2652P / CC2652R (Sonoff Dongle Plus, SZBT-7) | zstack | ✅ Recommended |
| CC2652RB (Tube's CC2652RB) | zstack | ✅ Recommended |
| CC1352P | zstack | ✅ Supported |
| ConBee II / RaspBee II | deconz | ✅ Supported |
| EZSP / EFR32 (Sonoff Dongle Plus-E, HUSBZB-1) | ezsp / ember | ⚠️ Experimental |
| ZiGate | zigate | ⚠️ Experimental |
| nRF (ZBOSS) | zboss | ⚠️ Experimental |
| CC2531 | zstack | ❌ Not recommended (old, limited) |

### Network coordinators (TCP / mDNS)

Set `serial_port` to a URI instead of a device path — no extra drivers or software needed.

| Device | serial_port example |
|---|---|
| SLZB-06 / SLZB-06M | `tcp://192.168.1.100:6638` |
| Tube's Zigbee Gateway | `tcp://192.168.1.100:6638` |
| UZG-01 | `tcp://192.168.1.100:6638` |
| ZigStar | `tcp://192.168.1.100:6638` |
| Any mDNS/Zeroconf adapter | `mdns://hostname` |

---

## Services

| Service | Description |
|---|---|
| `zigbee2hass.permit_join` | Open/close network for new device pairing |
| `zigbee2hass.ping_device` | Ping a device, returns latency in ms |
| `zigbee2hass.backup` | Trigger immediate NVRam backup |
| `zigbee2hass.migrate_from_z2m` | Import from a Z2M data directory |
| `zigbee2hass.restart_addon` | Restart the Zigbee controller |

---

## Reliability Features

**Command confirmation** — every command sent to a device waits for a state report confirmation before resolving. If no confirmation arrives within the timeout, the command is retried (configurable, default 3 attempts).

**State reconciliation** — when the HA integration (re)connects to the add-on, it receives a full device state snapshot. Any state drift is immediately corrected — no silent desync.

**Coordinator watchdog** — if no messages are received from the coordinator for 2 minutes, the watchdog attempts an automatic reconnect. After 3 consecutive failures, HA is alerted and a `coordinator_failed` event is fired.

**Smart availability** — mains-powered devices are actively pinged on a configurable interval. Battery-powered end devices use silence detection respecting their sleep cycles.

**NVRam backup** — the coordinator NVRam (which stores your paired device network) is automatically backed up every hour by default. This lets you swap coordinator hardware without re-pairing all devices.

---

## Configuration Options

| Option | Default | Description |
|---|---|---|
| `serial_port` | `/dev/ttyUSB0` | Coordinator path or URI — see below |
| `adapter` | `auto` | Adapter type: auto, zstack, deconz, ezsp, ember, zigate, zboss |
| `baudrate` | `115200` | Serial baud rate (USB only — ignored for TCP/mDNS) |
| `rtscts` | `false` | Hardware flow control (USB only — ConBee II requires `true`) |
| `disable_led` | `false` | Disable the coordinator LED (SLZB-06, some CC2652P sticks) |
| `channel` | `11` | Zigbee channel (11-26) |
| `log_level` | `info` | Log level: debug, info, warning, error |
| `availability_timeout` | `300` | Seconds before battery device marked unavailable |
| `availability_ping_interval` | `60` | Seconds between mains device pings |
| `command_timeout` | `5000` | Milliseconds to wait for command confirmation |
| `command_retries` | `3` | Number of command retry attempts |
| `nvram_backup` | `true` | Enable automatic NVRam backups |
| `nvram_backup_interval` | `3600` | Seconds between automatic backups |

#### `serial_port` formats

```
/dev/ttyUSB0                    # USB serial (also /dev/serial/by-id/...)
tcp://192.168.1.100:6638        # Network coordinator over TCP
mdns://slzb-06                  # Network coordinator via mDNS/Zeroconf
```

---

## License

MIT © 2026
