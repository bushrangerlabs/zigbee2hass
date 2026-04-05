'use strict';

const fs   = require('fs');
const path = require('path');
const { Controller } = require('zigbee-herdsman');
const { getLogger }  = require('./logger');
const { isNetworkPort } = require('./config');

/**
 * Extract network parameters from coordinator_backup.json (any known format).
 *
 * Supports:
 *   open-coordinator-backup: { pan_id: "84bf", channel: 25, channel_mask: [11],
 *                               extended_pan_id: "7051410511934ec3",
 *                               network_key: { key: "32eb..." } }
 *   old herdsman format:     { networkOptions: { panId, channelList, extendedPanId,
 *                               networkKey } }
 *
 * Returns:
 *   panId          - numeric PAN ID
 *   channel        - operating channel (for log display)
 *   channelMask    - number[] channel list to pass to herdsmanConfig (backup.channel_mask)
 *   extendedPanId  - number[] byte array of extended PAN ID
 *   networkKey     - number[] byte array of network key (null if not present)
 * All fields null on failure.
 */
function readBackupNetworkParams(backupFile, log) {
  try {
    const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

    // new open-coordinator-backup format
    if (backup.pan_id !== undefined && backup.channel !== undefined) {
      const panId = typeof backup.pan_id === 'string'
        ? parseInt(backup.pan_id.replace(/^0x/i, ''), 16)
        : Number(backup.pan_id);
      const channel = Number(backup.channel);
      if (panId > 0 && panId < 0xFFFF && channel >= 11 && channel <= 26) {
        // channel_mask is the channel list herdsman stores in backup.networkOptions.channelList
        const channelMask = Array.isArray(backup.channel_mask) && backup.channel_mask.length
          ? backup.channel_mask.map(Number)
          : [channel];
        // extended_pan_id as byte array
        const extendedPanId = backup.extended_pan_id
          ? Buffer.from(backup.extended_pan_id.replace(/^0x/i, ''), 'hex').toJSON().data
          : null;
        // network key as byte array
        const networkKey = backup.network_key?.key
          ? Buffer.from(backup.network_key.key, 'hex').toJSON().data
          : null;
        return { panId, channel, channelMask, extendedPanId, networkKey };
      }
    }

    // old herdsman format: { networkOptions: { panId, channelList, extendedPanId, networkKey } }
    if (backup.networkOptions?.panId && backup.networkOptions?.channelList?.length) {
      const panId       = Number(backup.networkOptions.panId);
      const channelMask = backup.networkOptions.channelList.map(Number);
      const channel     = channelMask[0];
      if (panId > 0 && panId < 0xFFFF && channel >= 11 && channel <= 26) {
        const extendedPanId = Array.isArray(backup.networkOptions.extendedPanId)
          ? backup.networkOptions.extendedPanId
          : null;
        const networkKey = Array.isArray(backup.networkOptions.networkKey)
          ? backup.networkOptions.networkKey
          : null;
        return { panId, channel, channelMask, extendedPanId, networkKey };
      }
    }

    log.debug('[zigbee] coordinator_backup.json present but could not extract network params — using config.yaml values');
  } catch (err) {
    log.debug(`[zigbee] Could not read coordinator_backup.json for network param override: ${err.message}`);
  }
  return { panId: null, channel: null, channelMask: null, extendedPanId: null, networkKey: null };
}

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

    // ── Network parameter reconciliation ─────────────────────────────────
    // When migrating from Zigbee2MQTT the user's config.yaml almost certainly
    // disagrees with the real network (e.g. config has channel=11/pan_id=0x1a62
    // but the actual Z2M network is channel=25/pan_id=0x84bf).
    //
    // herdsman determineStrategy() decision tree:
    //   configMatchesAdapter  → startup  (fast path)
    //   !config && backup && backupMatchesAdapter && forceStart → startup
    //   !config && backup && !backupMatchesAdapter && configMatchesBackup → restoreBackup
    //   otherwise → startCommissioning (DESTRUCTIVE — wipes NIB)
    //
    // forceStartWithInconsistentAdapterConfiguration ONLY helps when
    // backupMatchesAdapter is true but configMatchesAdapter is false.  When
    // BOTH are false the only safe path is configMatchesBackup → restoreBackup.
    //
    // Strategy:
    //   1. Override ALL four network params from the backup so that
    //      configMatchesBackup = true → restoreBackup (proper NV restore).
    //   2. extendedPanID is also passed so configMatchesAdapter can fire:
    //      herdsman checks direct + reversed byte order, so it matches
    //      regardless of how znp_key_sync wrote the bytes into the NIB.
    //   3. channelList = backup.channel_mask (NOT backup.channel) because
    //      herdsman stores the scan channel list in backup.networkOptions.channelList;
    //      the operating channel derives from the NIB's nwkLogicalChannel.
    //
    // This is a no-op when config.yaml already matches the backup (non-migrated installs).
    let configPanId      = parseInt(this.config.pan_id, 16);
    let configChannelList = [this.config.channel];
    let configExtPanId   = null;  // null → not passed to herdsmanConfig

    if (fs.existsSync(backupPath)) {
      const { panId: bPanId, channel: bChannel, channelMask: bMask, extendedPanId: bEpid }
        = readBackupNetworkParams(backupPath, this.log);
      if (bPanId && bChannel && bMask) {
        const prevPanId = configPanId;
        const prevCh    = configChannelList[0];
        configPanId       = bPanId;
        configChannelList = bMask;
        configExtPanId    = bEpid;
        if (bPanId !== prevPanId || bChannel !== prevCh) {
          this.log.info(
            `[zigbee] Network param override from coordinator_backup.json: ` +
            `channel ${prevCh}→${bChannel}, ` +
            `pan_id 0x${prevPanId.toString(16)}→0x${bPanId.toString(16)}, ` +
            `channelList [${bMask}]` +
            (bEpid ? `, epid ${bEpid.map(b => b.toString(16).padStart(2,'0')).join('')}` : '')
          );
        }
      }
    }

    // Build serialPort config — baudrate/rtscts only apply to USB, not TCP/mDNS
    const networkCoord = isNetworkPort(this.config.serial_port);
    const serialPort = {
      path:    this.config.serial_port,
      adapter: this.config.adapter === 'auto' ? undefined : this.config.adapter,
      ...(networkCoord ? {} : {
        baudRate: this.config.baudrate,
        rtscts:   this.config.rtscts,
      }),
    };

    const herdsmanConfig = {
      serialPort,
      databasePath:            dbPath,
      databaseBackupPath:      dbPath + '.bak',
      backupPath:              backupPath,
      acceptJoiningDeviceHandler: () => true,
      // legacy:false opts into herdsman v9 behaviour
      legacy:                  false,
      adapter: {
        disableLED:      this.config.disable_led,
        transmitPower:   this.config.transmit_power,
        // Allow startup when PRECFGKEY was overwritten by a prior failed
        // restoreBackup attempt but backupMatchesAdapter is true (active key
        // matches backup). syncNetworkKey() runs before herdsman to make
        // backupMatchesAdapter true when a stale backup caused the loop.
        forceStartWithInconsistentAdapterConfiguration: true,
      },
      network: {
        panID:        configPanId,
        channelList:  configChannelList,
        networkKey:   this._resolveNetworkKey(),
        ...(configExtPanId ? { extendedPanID: configExtPanId } : {}),
      },
    };

    this.log.info(`[zigbee] Starting coordinator (${networkCoord ? 'network' : 'USB'})...`, { port: this.config.serial_port });

    this.herdsman = new Controller(herdsmanConfig, this.log);
    this._attachEvents();

    try {
      await this.herdsman.start();
    } catch (err) {
      // Detect the ZStack "configuration-adapter mismatch" error and give
      // actionable guidance. This most commonly happens after a Z2M migration
      // if network_key.json was not updated to match coordinator_backup.json.
      if (err.message && err.message.includes('configuration-adapter mismatch')) {
        this.log.error('[zigbee] Coordinator configuration mismatch — the network key, channel, or PAN ID in config.yaml does not match what the coordinator has in its NVRam.');
        this.log.error('[zigbee] If you just migrated from Zigbee2MQTT, ensure coordinator_backup.json and network_key.json are both present in /data and contain matching keys.');
        this.log.error('[zigbee] If you replaced coordinator hardware, restore a coordinator_backup.json from your previous coordinator first.');
      }
      throw err;
    }

    this.log.info('[zigbee] Coordinator started');

    // Log coordinator firmware info for diagnostics
    try {
      const info = await this.herdsman.getCoordinatorVersion();
      this.log.info(`[zigbee] Coordinator: ${info.type ?? '?'} rev${info.meta?.revision ?? info.revision ?? '?'}`);
    } catch (e) {
      this.log.debug(`[zigbee] Could not read coordinator version: ${e.message}`);
    }

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
   *
   * @param {string}  ieeeAddress - IEEE address of the device to remove
   * @param {boolean} force       - When true, skip the over-the-air leave
   *                                request and remove only from the database.
   *                                Use when the device is unreachable/replaced.
   */
  async removeDevice(ieeeAddress, force = false) {
    if (!this.herdsman) throw new Error('Coordinator not started');
    const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddress);
    if (!device) throw new Error(`Device not found: ${ieeeAddress}`);
    if (force) {
      this.log.info(`[zigbee] Force-removing device (skip leave request): ${ieeeAddress}`);
    } else {
      try {
        await device.removeFromNetwork();
      } catch (err) {
        this.log.warn(`[zigbee] removeFromNetwork failed for ${ieeeAddress}: ${err.message} — removing from DB anyway`);
      }
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

  // ── Coordinator endpoint ──────────────────────────────────────────────────

  getCoordinatorEndpoint() {
    const coordinators = this.herdsman.getDevicesByType('Coordinator');
    if (!coordinators || coordinators.length === 0) throw new Error('Coordinator device not found');
    return coordinators[0].getEndpoint(1);
  }

  // ── Network map (LQI scan) ────────────────────────────────────────────────

  async getNetworkMap() {
    const devices  = this.herdsman.getDevices();
    const nodes    = [];
    const nodeIeee = new Set(); // known IEEE addresses — used to filter phantom neighbors
    const linksMap = new Map(); // sorted "A-B" key => { source, target, lqi }

    for (const device of devices) {
      nodes.push({
        ieee:  device.ieeeAddr,
        type:  device.type,
        model: device.modelID,
        nwk:   device.networkAddress,
      });
      nodeIeee.add(device.ieeeAddr);
    }

    for (const device of devices) {
      try {
        const neighbors = await Promise.race([
          device.lqi(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('lqi timeout')), 5000)),
        ]);
        for (const nb of (neighbors || [])) {
          const a = device.ieeeAddr;
          const b = nb.eui64;   // zigbee-herdsman v9 LQI entry uses eui64, not ieeeAddr
          // Skip self-links, broadcast placeholders, or any address not in our
          // known node set (e.g. stale neighbors from a previous network that
          // the coordinator still has cached in its LQI table).
          if (!a || !b || a === b) continue;
          if (!nodeIeee.has(a) || !nodeIeee.has(b)) continue;
          const key = [a, b].sort().join('|');
          if (!linksMap.has(key) || linksMap.get(key).lqi < nb.lqi) {
            linksMap.set(key, { source: a, target: b, lqi: nb.lqi });
          }
        }
      } catch {
        // Sleeping/offline devices don't respond — silently skip
      }
    }

    return { nodes, links: Array.from(linksMap.values()) };
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  getGroups() {
    return this.herdsman.getGroups().map(g => this._serializeGroup(g));
  }

  createGroup(groupId) {
    const existing = this.herdsman.getGroupByID(groupId);
    if (existing) throw new Error(`Group ${groupId} already exists`);
    this.herdsman.createGroup(groupId);
    return this._serializeGroup(this.herdsman.getGroupByID(groupId));
  }

  removeGroup(groupId) {
    const group = this.herdsman.getGroupByID(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);
    group.removeFromDatabase();
  }

  addGroupMember(groupId, ieeeAddr, endpointId = 1) {
    const group  = this.herdsman.getGroupByID(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);
    const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
    if (!device) throw new Error(`Device ${ieeeAddr} not found`);
    const ep = device.getEndpoint(endpointId);
    if (!ep) throw new Error(`Endpoint ${endpointId} not found on ${ieeeAddr}`);
    group.addMember(ep);
    return this._serializeGroup(group);
  }

  removeGroupMember(groupId, ieeeAddr, endpointId = 1) {
    const group  = this.herdsman.getGroupByID(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);
    const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
    if (!device) throw new Error(`Device ${ieeeAddr} not found`);
    const ep = device.getEndpoint(endpointId);
    if (!ep) throw new Error(`Endpoint ${endpointId} not found on ${ieeeAddr}`);
    group.removeMember(ep);
    return this._serializeGroup(group);
  }

  _serializeGroup(group) {
    return {
      id:      group.groupID,
      members: group.members.map(ep => ({
        ieee_address: ep.getDevice()?.ieeeAddr ?? null,
        endpoint_id:  ep.ID,
      })).filter(m => m.ieee_address),
    };
  }

  // ── OTA ───────────────────────────────────────────────────────────────────

  /**
   * Send imageNotify to a device to trigger it to start an OTA update check.
   * The device will respond with queryNextImageRequest which herdsman handles.
   * Returns true if the command was sent successfully.
   */
  async triggerOtaCheck(ieeeAddr) {
    const device = this.herdsman.getDeviceByIeeeAddr(ieeeAddr);
    if (!device) throw new Error(`Device ${ieeeAddr} not found`);
    const ep = device.endpoints[0];
    if (!ep) throw new Error(`No endpoints on ${ieeeAddr}`);
    // imageNotify with payloadType=0 (query jitter) asks device to check for OTA
    await ep.commandResponse('genOta', 'imageNotify', {
      payloadType: 0,
      queryJitter: 100,
    }, {});
    return { triggered: true, ieee_address: ieeeAddr };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _attachEvents() {
    const h = this.herdsman;

    h.on('deviceJoined',            (d)    => this.emit('device_joined',              this._serializeDevice(d.device)));
    h.on('deviceInterview',         (d)    => {
      // Pass the raw herdsman Device so zhc.findByDevice() can match it correctly
      if (d.status === 'successful')  this.emit('device_interview_succeeded', d.device);
      else if (d.status === 'started') this.emit('device_interview_started',   this._serializeDevice(d.device));
      else                             this.emit('device_interview_failed',    d.device);  // raw device — needed for retry
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

  /**
   * Re-trigger the interview for a device that previously failed.
   * Called by server.js retry logic after a delay.
   */
  async retryInterview(rawDevice) {
    this.log.info(`[zigbee] Retrying interview for ${rawDevice.ieeeAddr}`);
    await rawDevice.interview();
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
      interview_completed: device.interviewState === 'SUCCESSFUL' || !!device.interviewCompleted,
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
    // Keep raw herdsman objects so zhc v25 fromZigbee converters receive what
    // they expect: raw Endpoint (for zclTransactionSequenceNumber etc.),
    // raw Device, and msg.meta (for deduplication).
    return {
      ieee_address:    msg.device.ieeeAddr,
      network_address: msg.device.networkAddress,
      endpoint:        msg.endpoint,          // raw Endpoint object
      endpoint_id:     msg.endpoint.ID,       // numeric ID for our own lookups
      type:            msg.type,
      cluster:         msg.cluster,
      data:            msg.data,
      link_quality:    msg.linkquality,
      meta:            msg.meta ?? {},        // contains zclTransactionSequenceNumber
      groupID:         msg.groupID,
      device:          msg.device,            // raw Device object
    };
  }
}

module.exports = { ZigbeeController };
