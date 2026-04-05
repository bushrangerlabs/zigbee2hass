'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = process.env.DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'options.json'); // written by HA Supervisor

/**
 * Default configuration values.
 * These are overridden by the HA add-on options or env vars.
 */
const DEFAULTS = {
  serial_port:              '/dev/ttyUSB0',
  adapter:                  'auto',
  // Serial / network port options
  // For USB adapters:     serial_port: '/dev/ttyUSB0'  (or /dev/serial/by-id/...)
  // For TCP coordinators: serial_port: 'tcp://192.168.1.100:6638'  (SLZB-06, Tube's, etc.)
  // For mDNS discovery:   serial_port: 'mdns://slzb-06'  (adapter must support Zeroconf)
  baudrate:                 115200,        // USB serial baud rate (ignored for TCP/mDNS)
  rtscts:                   false,         // USB hardware flow control (ignored for TCP/mDNS)
  disable_led:              false,         // Disable coordinator LED if supported
  channel:                  11,
  pan_id:                   '0x1a62',
  network_key:              'GENERATE',
  transmit_power:           20,
  websocket_port:           8756,
  log_level:                'info',
  availability_timeout:     300,        // seconds before device marked unavailable
  availability_ping_interval: 120,      // seconds between pings for mains devices (120s = less radio pressure)
  availability_ping_failures: 5,        // consecutive ping failures before marking a device offline
  startup_grace_period:     300,        // seconds before first availability ping (allow mesh to rebuild after restart)
  startup_command_holdoff:  300,        // seconds to queue set_state commands for offline devices instead of sending immediately (0 = disabled)
  command_timeout:          5000,       // ms to wait for command ack
  command_retries:          3,
  command_retry_delay:      500,        // ms base delay between command retries (multiplied by attempt number)
  configure_inter_device_delay: 3000,   // ms gap between each device in the startup configure queue
  interview_retries:        3,          // max re-interview attempts for devices that fail initial interview
  interview_retry_delay:    15,         // seconds between interview retries
  log_buffer_size:          500,        // number of log entries kept in the ring buffer (visible in Log tab)
  occupancy_timeout:        90,         // seconds before auto-clearing occupancy/presence (0 = disable)
  nvram_backup:             true,
  nvram_backup_interval:    3600,       // seconds between automatic NVRam backups
  startup_snapshot_keep:    10,         // number of pre-start snapshots to retain (0 = disable snapshots)
  permit_join_timeout:      254,        // seconds to keep network open for pairing on startup (0 = disabled)
  data_dir:                 DATA_DIR,
};

function loadConfig() {
  let fileConfig = {};

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error(`[config] Failed to parse ${CONFIG_FILE}: ${e.message}`);
    }
  }

  const config = { ...DEFAULTS, ...fileConfig };

  // Allow env-var overrides for development/testing outside HA
  if (process.env.SERIAL_PORT)            config.serial_port            = process.env.SERIAL_PORT;
  if (process.env.ADAPTER)               config.adapter                = process.env.ADAPTER;
  if (process.env.WEBSOCKET_PORT)        config.websocket_port         = parseInt(process.env.WEBSOCKET_PORT);
  if (process.env.LOG_LEVEL)             config.log_level              = process.env.LOG_LEVEL;
  if (process.env.DATA_DIR)              config.data_dir               = process.env.DATA_DIR;

  return config;
}

/** Returns true when the port is a network address (TCP or mDNS) rather than a local serial device */
function isNetworkPort(port) {
  return typeof port === 'string' && (port.startsWith('tcp://') || port.startsWith('mdns://'));
}

module.exports = { loadConfig, isNetworkPort };
