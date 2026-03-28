'use strict';

/**
 * Zigbee2HASS Add-on — main entry point
 *
 * Boot sequence:
 *  1. Load config
 *  2. Start logger
 *  3. Start zigbee-herdsman (ZigbeeController)
 *  4. Start DeviceManager
 *  5. Start WebSocket API
 *  6. Wire events together
 *
 * On SIGTERM/SIGINT: graceful shutdown in reverse order.
 */

const { loadConfig }      = require('./config');
const { initLogger, getLogger } = require('./logger');
const { ZigbeeController } = require('./zigbee');
const { DeviceManager }   = require('./devices');
const { WebSocketAPI }    = require('./websocket');

async function main() {
  const config = loadConfig();
  const log    = initLogger(config.log_level);

  log.info('=== Zigbee2HASS starting ===');
  log.info(`Serial port: ${config.serial_port}`);
  log.info(`Adapter:     ${config.adapter}`);
  log.info(`Channel:     ${config.channel}`);
  log.info(`WS port:     ${config.websocket_port}`);

  // Central event bus — all components communicate through this
  const handlers = {};
  function emit(event, payload) {
    log.debug(`[event] ${event}`);
    const list = handlers[event] ?? [];
    for (const fn of list) {
      try { fn(payload); } catch (e) { log.error(`[event] Handler error (${event}): ${e.message}`); }
    }
  }
  function on(event, fn) {
    if (!handlers[event]) handlers[event] = [];
    handlers[event].push(fn);
  }

  // ── Instantiate components ──────────────────────────────────────────────

  const zigbee  = new ZigbeeController(config, emit);
  const devices = new DeviceManager(config, zigbee, emit);
  const wsApi   = new WebSocketAPI(config.websocket_port, zigbee, devices);

  // ── Wire events ─────────────────────────────────────────────────────────

  // Device lifecycle
  on('device_interview_succeeded', (device) => {
    devices.onDeviceInterview(device);
  });
  on('device_message', (msg) => {
    devices.onMessage(msg);
  });
  on('device_leave', ({ ieee_address }) => {
    devices.onDeviceLeave(ieee_address);
    wsApi.broadcast('zigbee2hass/device/left', { ieee_address });
  });

  // Forward events to WebSocket clients
  on('device_joined',        (d) => wsApi.broadcast('zigbee2hass/device/joined',       d));
  on('device_ready',         (d) => wsApi.broadcast('zigbee2hass/device/ready',        d));
  on('state_changed',        (d) => wsApi.broadcast('zigbee2hass/device/state',        d));
  on('availability_changed', (d) => wsApi.broadcast('zigbee2hass/device/availability', d));
  on('permit_join_changed',  (d) => wsApi.broadcast('zigbee2hass/permitjoin',          d));

  // ── NVRam auto-backup ───────────────────────────────────────────────────
  let nvramTimer = null;
  if (config.nvram_backup) {
    nvramTimer = setInterval(async () => {
      try {
        await zigbee.backup();
        wsApi.broadcast('zigbee2hass/bridge/backup', { success: true, timestamp: Date.now() });
      } catch (err) {
        log.error(`[main] NVRam backup failed: ${err.message}`);
      }
    }, config.nvram_backup_interval * 1000);
  }

  // ── Start sequence ──────────────────────────────────────────────────────

  try {
    await zigbee.start();
    devices.start();
    wsApi.start();

    // Initial backup after coordinator starts
    if (config.nvram_backup) {
      setTimeout(() => zigbee.backup().catch(e => log.warn(`Initial backup failed: ${e.message}`)), 5000);
    }

    log.info('=== Zigbee2HASS ready ===');
    wsApi.broadcast('zigbee2hass/bridge/state', { state: 'online' });

  } catch (err) {
    log.error(`[main] Startup failed: ${err.message}`);
    log.error(err.stack);
    process.exit(1);
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────

  async function shutdown(signal) {
    log.info(`[main] Received ${signal} — shutting down gracefully`);
    wsApi.broadcast('zigbee2hass/bridge/state', { state: 'offline' });

    if (nvramTimer) clearInterval(nvramTimer);

    wsApi.stop();
    devices.stop();

    // Final NVRam backup before shutting down coordinator
    if (config.nvram_backup) {
      try { await zigbee.backup(); } catch {}
    }

    await zigbee.stop();
    log.info('[main] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.error(`[main] Uncaught exception: ${err.message}`);
    log.error(err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`[main] Unhandled rejection: ${reason}`);
  });
}

main();


async function main() {
  const config = loadConfig();
  const log    = initLogger(config.log_level);

  log.info('=== Zigbee2HASS starting ===');
  log.info(`Serial port: ${config.serial_port}`);
  log.info(`Adapter:     ${config.adapter}`);
  log.info(`Channel:     ${config.channel}`);
  log.info(`WS port:     ${config.websocket_port}`);

  // Central event bus — all components communicate through this
  const handlers = {};
  function emit(event, payload) {
    log.debug(`[event] ${event}`);
    const list = handlers[event] ?? [];
    for (const fn of list) {
      try { fn(payload); } catch (e) { log.error(`[event] Handler error (${event}): ${e.message}`); }
    }
  }
  function on(event, fn) {
    if (!handlers[event]) handlers[event] = [];
    handlers[event].push(fn);
  }

  // ── Instantiate components ──────────────────────────────────────────────

  const zigbee  = new ZigbeeController(config, emit);
  const devices = new DeviceManager(config, zigbee, emit);
  const watchdog = new Watchdog({
    silenceThreshold: Math.max((config.availability_ping_interval ?? 60) * 4 * 1000, 300_000),
    checkInterval:    30_000,
    maxFailures:      3,
    onReconnect: () => zigbee.reconnect(),
    onFailed:    () => wsApi.broadcast('zigbee2hass/bridge/state', { state: 'coordinator_failed' }),
    onHealthy:   () => wsApi.broadcast('zigbee2hass/bridge/state', { state: 'online' }),
  });
  const wsApi   = new WebSocketAPI(config.websocket_port, zigbee, devices, watchdog);

  // ── Wire events ─────────────────────────────────────────────────────────

  // Watchdog heartbeat on any Zigbee activity
  on('device_message',   () => watchdog.heartbeat());
  on('device_announce',  () => watchdog.heartbeat());
  on('device_joined',    () => watchdog.heartbeat());

  // Periodic coordinator keepalive so watchdog heartbeats even with no devices
  let keepaliveTimer = null;

  // Device lifecycle
  on('device_interview_succeeded', (device) => {
    devices.onDeviceInterview(device);
  });
  on('device_message', (msg) => {
    devices.onMessage(msg);
  });
  on('device_leave', ({ ieee_address }) => {
    devices.onDeviceLeave(ieee_address);
    wsApi.broadcast('zigbee2hass/device/left', { ieee_address });
  });

  // Forward events to WebSocket clients
  on('device_joined',     (d) => wsApi.broadcast('zigbee2hass/device/joined',       d));
  on('device_ready',      (d) => wsApi.broadcast('zigbee2hass/device/ready',        d));
  on('state_changed',     (d) => wsApi.broadcast('zigbee2hass/device/state',        d));
  on('availability_changed', (d) => wsApi.broadcast('zigbee2hass/device/availability', d));
  on('permit_join_changed',  (d) => wsApi.broadcast('zigbee2hass/permitjoin',          d));

  // ── NVRam auto-backup ───────────────────────────────────────────────────
  let nvramTimer = null;
  if (config.nvram_backup) {
    nvramTimer = setInterval(async () => {
      try {
        await zigbee.backup();
        wsApi.broadcast('zigbee2hass/bridge/backup', { success: true, timestamp: Date.now() });
      } catch (err) {
        log.error(`[main] NVRam backup failed: ${err.message}`);
      }
    }, config.nvram_backup_interval * 1000);
  }

  // ── Start sequence ──────────────────────────────────────────────────────

  try {
    await zigbee.start();
    devices.start();
    watchdog.start();
    wsApi.start();

    // Keepalive: ping coordinator every availability_ping_interval seconds
    // so the watchdog heartbeats even when no Zigbee devices are transmitting
    const pingIntervalMs = (config.availability_ping_interval ?? 60) * 1000;
    keepaliveTimer = setInterval(async () => {
      try {
        await zigbee.ping();
        watchdog.heartbeat();
      } catch (err) {
        log.warn(`[main] Coordinator keepalive ping failed: ${err.message}`);
      }
    }, pingIntervalMs);

    // Initial backup after coordinator starts
    if (config.nvram_backup) {
      setTimeout(() => zigbee.backup().catch(e => log.warn(`Initial backup failed: ${e.message}`)), 5000);
    }

    log.info('=== Zigbee2HASS ready ===');
    wsApi.broadcast('zigbee2hass/bridge/state', { state: 'online' });

  } catch (err) {
    log.error(`[main] Startup failed: ${err.message}`);
    log.error(err.stack);
    process.exit(1);
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────

  async function shutdown(signal) {
    log.info(`[main] Received ${signal} — shutting down gracefully`);
    wsApi.broadcast('zigbee2hass/bridge/state', { state: 'offline' });

    if (nvramTimer) clearInterval(nvramTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);

    wsApi.stop();
    watchdog.stop();
    devices.stop();

    // Final NVRam backup before shutting down coordinator
    if (config.nvram_backup) {
      try { await zigbee.backup(); } catch {}
    }

    await zigbee.stop();
    log.info('[main] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.error(`[main] Uncaught exception: ${err.message}`);
    log.error(err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`[main] Unhandled rejection: ${reason}`);
  });
}

main();
