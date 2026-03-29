'use strict';

const path = require('path');
const { Controller } = require('zigbee-herdsman');
const { getLogger }  = require('./logger');

/**
 * ZigbeeController wraps zigbee-herdsman's Controller.
 *
 * Responsibilities:
 *  - Start/stop the coordinator
 *  - Emit normalised events upward (device_joined, device_interview_started,
 *    device_interview_succeeded, device_interview_failed, device_leave,
 *    device_message, device_announce)
 *  - Provide helpers: permitJoin, ping, publish, getDevices, getDevice
 *  - NVRam backup/restore
 */
class ZigbeeController {
  /**
   * @param {object} config  - loaded config from config.js
   * @param {function} emit  - fn(event, payload) called for every Zigbee event
   */
  constructor(config, emit) {
    this.config    = config;
    this.emit      = emit;
    this.log       = getLogger();
    this.herdsman  = null;
    this._starting = false;
  }

  async start() {
    if (this._starting) return;
    this._starting = true;

    const dbPath     = path.join(this.config.data_dir, 'database.db');
    const backupPath = path.join(this.config.data_dir, 'coordinator_backup.json');

    const herdsmanConfig = {
      serialPort: {
        path:    this.config.serial_port,
        adapter: this.config.adapter === 'auto' ? undefined : this.config.adapter,
      },
      databasePath:            dbPath,
      databaseBackupPath:      dbPath + '.bak',
      backupPath:              backupPath,
      acceptJoiningDeviceHandler: () => true,
      adapter: {
        concurrent:     16,
        delay:          0,
        disableLED:     false,
        transmitPower:  this.config.transmit_power,
      },
      network: {
        panID:        parseInt(this.config.pan_id, 16),
        channelList:  [this.config.channel],
        networkKey:   this._resolveNetworkKey(),
      },
    };

    this.log.info('[zigbee] Starting coordinator...', { port: this.config.serial_port });

    this.herdsman = new Controller(herdsmanConfig, this.log);
    this._attachEvents();

    await this.herdsman.start();

    this.log.info('[zigbee] Coordinator started');
    this._starting = false;
  }

  async stop() {
    if (!this.herdsman) return;
    this.log.info('[zigbee] Stopping coordinator...');
    await this.herdsman.stop();
    this.herdsman = null;
    this.log.info('[zigbee] Coordinator stopped');
  }

  async reconnect() {
    this.log.info('[zigbee] Reconnecting...');
    await this.stop();
    await new Promise(r => setTimeout(r, 2000));
    await this.start();
  }

  /**
   * Resolve the network key:
   * - If config is 'GENERATE', load from /data/network_key.json or generate+save a new one.
   * - Otherwise parse the comma-separated or array value from config.
   * @returns {number[]} 16-element byte array
   */
  _resolveNetworkKey() {
    const keyFile = require('path').join(this.config.data_dir, 'network_key.json');
    const fs = require('fs');

    if (this.config.network_key === 'GENERATE') {
      if (fs.existsSync(keyFile)) {
        try {
          const saved = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
          if (Array.isArray(saved) && saved.length === 16) {
            this.log.info('[zigbee] Loaded persisted network key');
            return saved;
          }
        } catch (_) { /* fall through to generate */ }
      }
      // Generate a new random 16-byte key
      const key = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
      fs.writeFileSync(keyFile, JSON.stringify(key), 'utf8');
      this.log.info('[zigbee] Generated and saved new network key');
      return key;
    }

    // Explicit key: accept array or comma-separated string
    if (Array.isArray(this.config.network_key)) return this.config.network_key;
    return String(this.config.network_key).split(',').map(Number);
  }

  // ── Pairing ──────────────────────────────────────────────────────────────

  async permitJoin(permit, device = undefined, timeout = 254) {
    // herdsman v9 API: permitJoin(time: number, device?) — 0 closes, N opens for N seconds
    const time = permit ? timeout : 0;
    await this.herdsman.permitJoin(time, device);
    this.log.info(`[zigbee] Permit join: ${permit} (${time}s)`);
  }

  // ── Device access ─────────────────────────────────────────────────────────

  getDevices() {
    return this.herdsman.getDevices().map(d => this._serializeDevice(d));
  }

  getRawDevices() {
    return this.herdsman.getDevices();
  }

  getDevice(ieeeAddr) {
    const d = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
    return d ? this._serializeDevice(d) : null;
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  /**
   * Publish a state/command to a device endpoint.
   * Returns a Promise that resolves when herdsman acknowledges the publish.
   */
  async publish(ieeeAddr, endpoint, cluster, command, payload) {
    const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
    if (!device) throw new Error(`Device ${ieeeAddr} not found`);

    const ep = device.getEndpoint(endpoint);
    if (!ep) throw new Error(`Endpoint ${endpoint} not found on ${ieeeAddr}`);

    return ep.command(cluster, command, payload);
  }

  async readAttribute(ieeeAddr, endpoint, cluster, attributes) {
    const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
    if (!device) throw new Error(`Device ${ieeeAddr} not found`);

    const ep = device.getEndpoint(endpoint);
    return ep.read(cluster, attributes);
  }

  /** Ping a device — returns latency in ms or throws on timeout */
  async pingDevice(ieeeAddr) {
    const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
    if (!device) throw new Error(`Device ${ieeeAddr} not found`);

    const start = Date.now();
    await device.ping();
    return Date.now() - start;
  }

  /** Ping the coordinator itself — proves ZNP serial link is alive */
  async ping() {
    await this.herdsman.getCoordinatorVersion();
  }

  // ── Device removal ──────────────────────────────────────────────────────────

  /**
   * Remove a device from the Zigbee network and from the herdsman database.
   * A leave request is sent first (best-effort); the device is always removed
   * from the DB even if the radio command fails (e.g. device is offline).
   */
  async removeDevice(ieeeAddress) {
    if (!this.herdsman) throw new Error('Coordinator not started');
    const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddress);
    if (!device) throw new Error(`Device not found: ${ieeeAddress}`);
    try {
      await device.removeFromNetwork();
    } catch (err) {
      this.log.warn(`[zigbee] removeFromNetwork failed for ${ieeeAddress}: ${err.message} — removing from DB anyway`);
    }
    await device.removeFromDatabase();
    this.log.info(`[zigbee] Device removed: ${ieeeAddress}`);
  }

  // ── NVRam backup ──────────────────────────────────────────────────────────

  async backup() {
    const backupPath = path.join(this.config.data_dir, 'coordinator_backup.json');
    await this.herdsman.backup();
    this.log.info(`[zigbee] NVRam backup saved to ${backupPath}`);
    return backupPath;
  }

  coordinatorInfo() {
    return this.herdsman.getCoordinatorVersion();
  }

  networkParameters() {
    return this.herdsman.getNetworkParameters();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _attachEvents() {
    const h = this.herdsman;

    h.on('deviceJoined',            (d)    => this.emit('device_joined',              this._serializeDevice(d.device)));
    h.on('deviceInterview',         (d)    => {
      // Pass the raw herdsman Device so zhc.findByDevice() can match it correctly
      if (d.status === 'successful')  this.emit('device_interview_succeeded', d.device);
      else if (d.status === 'started') this.emit('device_interview_started',   this._serializeDevice(d.device));
      else                             this.emit('device_interview_failed',    this._serializeDevice(d.device));
    });
    h.on('deviceAnnounce',          (d)    => this.emit('device_announce',            d.device));  // raw device for definition lookup
    h.on('deviceLeave',             (d)    => this.emit('device_leave',               { ieee_address: d.ieeeAddr }));
    h.on('message',                 (msg)  => {
      // Skip OTA cluster messages — herdsman handles queryNextImageRequest
      // internally (responds with NOT_AVAILABLE). Emitting them as device_message
      // floods the bus every few seconds for battery devices with OTA enabled.
      if (msg.cluster === 'genOta') return;
      this.emit('device_message', this._normalizeMessage(msg));
    });
    h.on('permitJoinChanged',       (d)    => this.emit('permit_join_changed',        d));
    h.on('lastSeenChanged',         (d)    => this.emit('last_seen_changed',          { ieee_address: d.device.ieeeAddr, last_seen: d.device.lastSeen }));
  }

  serializeDevice(device) {
    return this._serializeDevice(device);
  }

  _serializeDevice(device) {
    return {
      ieee_address:     device.ieeeAddr,
      network_address:  device.networkAddress,
      type:             device.type,
      manufacturer:     device.manufacturerName,
      model_id:         device.modelID,
      power_source:     device.powerSource,
      interviewing:     device.interviewing,
      interview_completed: device.interviewCompleted,
      last_seen:        device.lastSeen,
      endpoints:        device.endpoints.map(ep => ({
        id:            ep.ID,
        input_clusters:  ep.inputClusters,
        output_clusters: ep.outputClusters,
        device_type:   ep.deviceType,
      })),
    };
  }

  _normalizeMessage(msg) {
    return {
      ieee_address:    msg.device.ieeeAddr,
      network_address: msg.device.networkAddress,
      endpoint:        msg.endpoint.ID,
      type:            msg.type,
      cluster:         msg.cluster,
      data:            msg.data,
      link_quality:    msg.linkquality,
    };
  }
}

module.exports = { ZigbeeController };
