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
  channel:                  11,
  pan_id:                   '0x1a62',
  network_key:              'GENERATE',
  transmit_power:           20,
  websocket_port:           8756,
  log_level:                'info',
  availability_timeout:     300,        // seconds before device marked unavailable
  availability_ping_interval: 60,       // seconds between pings for mains devices
  command_timeout:          5000,       // ms to wait for command ack
  command_retries:          3,
  nvram_backup:             true,
  nvram_backup_interval:    3600,       // seconds between automatic NVRam backups
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

module.exports = { loadConfig };
