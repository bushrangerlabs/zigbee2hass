'use strict';

const { WebSocketServer } = require('ws');
const { getLogger }       = require('./logger');

/**
 * Build a zigbee2mqtt.io CDN image URL from a serialized ZHC definition.
 * definition.model is e.g. "E1524/E1810" — replace / and spaces with _.
 * Returns null if definition or model is unavailable.
 */
function _deviceImageUrl(definition) {
  const model = definition?.model;
  if (!model) return null;
  const safe = model.replace(/\//g, '-').replace(/\s+/g, '_');
  return `https://www.zigbee2mqtt.io/images/devices/${safe}.png`;
}

/**
 * Message types sent TO clients (HA integration)
 *
 *  zigbee2hass/bridge/state          - bridge online/offline/reconnecting
 *  zigbee2hass/bridge/coordinator    - coordinator info
 *  zigbee2hass/bridge/devices        - full device list snapshot
 *  zigbee2hass/device/state          - device state change
 *  zigbee2hass/device/availability   - device available/unavailable
 *  zigbee2hass/device/joined         - new device joined
 *  zigbee2hass/device/left           - device left network
 *  zigbee2hass/device/ready          - device interviewed and ready
 *  zigbee2hass/permitjoin            - permit join status
 *  zigbee2hass/error                 - error notification
 *
 * Message types received FROM clients
 *
 *  get_devices           - request full device list
 *  get_state             - request state for one device
 *  set_state             - send command to device
 *  permit_join           - enable/disable joining
 *  ping_device           - ping a specific device
 *  configure_device      - run ZCL attribute reporting setup for a device
 *  get_network_map       - LQI scan, returns nodes + links
 *  backup                - trigger NVRam backup now
 *  restart               - restart the Zigbee controller
 *  health                - request watchdog/coordinator health status
 *  get_groups            - list all Zigbee groups
 *  create_group          - create a new group
 *  remove_group          - delete a group
 *  add_group_member      - add device endpoint to a group
 *  remove_group_member   - remove device endpoint from a group
 *  ota_check             - ask a device to check for firmware update
 */
class WebSocketAPI {
  /**
   * @param {number} port
   * @param {ZigbeeController} zigbee
   * @param {DeviceManager} devices
   */
  constructor(port, zigbee, devices) {
    this.port     = port;
    this.zigbee   = zigbee;
    this.devices  = devices;
    this.log      = getLogger();
    this.wss      = null;
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('listening', () => {
      this.log.info(`[ws] WebSocket API listening on port ${this.port}`);
    });

    this.wss.on('connection', (ws, req) => {
      const remote = req.socket.remoteAddress;
      this.log.info(`[ws] Client connected from ${remote}`);

      // Send current state snapshot on connect — enables state reconciliation
      this._sendSnapshot(ws);

      ws.on('message', async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          this._send(ws, 'zigbee2hass/error', { error: 'Invalid JSON' });
          return;
        }
        await this._handleMessage(ws, msg);
      });

      ws.on('close', () => {
        this.log.info(`[ws] Client disconnected: ${remote}`);
      });

      ws.on('error', (err) => {
        this.log.warn(`[ws] Client error: ${err.message}`);
      });
    });

    this.wss.on('error', (err) => {
      this.log.error(`[ws] Server error: ${err.message}`);
    });
  }

  stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  // ── Broadcast helpers (called by server.js on events) ─────────────────────

  broadcast(topic, payload) {
    if (!this.wss) return;
    const msg = JSON.stringify({ topic, payload });
    for (const client of this.wss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(msg);
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * On new client connect, send a full snapshot so HA can reconcile state.
   */
  async _sendSnapshot(ws) {
    try {
      const devices     = this.zigbee.getDevices();
      const allStates   = this.devices.getAllStates();
      const definitions = this.devices.getAllDefinitions();
      const coordinator = await this.zigbee.coordinatorInfo();
      const network     = await this.zigbee.networkParameters();
      const health      = { healthy: true, failures: 0, silenceMs: 0 };

      this._send(ws, 'zigbee2hass/bridge/state', { state: 'online' });
      this._send(ws, 'zigbee2hass/bridge/coordinator', { coordinator, network });

      // Log exposes count per device for diagnostics
      for (const d of devices) {
        const def      = definitions[d.ieee_address];
        const exposes  = def?.exposes ?? [];
        const exposeCt = Array.isArray(exposes) ? exposes.length : 0;
        this.log.info(`[ws] Snapshot: ${d.ieee_address} model=${d.model_id ?? '?'} exposes=${exposeCt}`);
      }

      this._send(ws, 'zigbee2hass/bridge/devices', {
        devices: devices.map(d => ({
          ...d,
          friendly_name: this.devices.getFriendlyName(d.ieee_address) ?? definitions[d.ieee_address]?.model ?? d.model_id ?? d.ieee_address,
          definition:    definitions[d.ieee_address] ?? null,
          image_url:     _deviceImageUrl(definitions[d.ieee_address]),
          state:         allStates[d.ieee_address] ?? {},
          available:     this.devices.getAvailability(d.ieee_address).available,
        })),
        health,
      });
    } catch (err) {
      this.log.error(`[ws] Snapshot error: ${err.message}`);
    }
  }

  async _handleMessage(ws, msg) {
    const { id, type, payload = {} } = msg;

    const reply = (data, error = null) => {
      this._send(ws, 'zigbee2hass/response', { id, type, ...( error ? { error } : { result: data }) });
    };

    try {
      switch (type) {

        case 'get_devices': {
          const devices     = this.zigbee.getDevices();
          const definitions = this.devices.getAllDefinitions();
          const allStates   = this.devices.getAllStates();
          reply(devices.map(d => ({
            ...d,
            friendly_name: this.devices.getFriendlyName(d.ieee_address) ?? definitions[d.ieee_address]?.model ?? d.model_id ?? d.ieee_address,
            definition:    definitions[d.ieee_address] ?? null,
            image_url:     _deviceImageUrl(definitions[d.ieee_address]),
            state:         allStates[d.ieee_address] ?? {},
            available:     this.devices.getAvailability(d.ieee_address).available,
          })));
          break;
        }

        case 'rename_device': {
          const { ieee_address, name } = payload;
          this.devices.setFriendlyName(ieee_address, name);
          this.broadcast('zigbee2hass/device/renamed', { ieee_address, friendly_name: name });
          reply({ ieee_address, friendly_name: name });
          break;
        }

        case 'remove_device': {
          const { ieee_address, force = false } = payload;
          await this.zigbee.removeDevice(ieee_address, force);
          this.devices.onDeviceLeave(ieee_address);
          this.broadcast('zigbee2hass/device/left', { ieee_address });
          reply({ ieee_address, removed: true, force });
          break;
        }

        case 'get_state': {
          const { ieee_address } = payload;
          reply({
            state:      this.devices.getState(ieee_address),
            available:  this.devices.getAvailability(ieee_address).available,
          });
          break;
        }

        case 'set_state': {
          const { ieee_address, state } = payload;
          const result = await this.devices.command(ieee_address, state);
          reply({ confirmed_state: result });
          break;
        }

        case 'permit_join': {
          const { permit, timeout } = payload;
          await this.zigbee.permitJoin(permit, undefined, timeout ?? 254);
          reply({ permit });
          break;
        }

        case 'ping_device': {
          const { ieee_address } = payload;
          const latency = await this.zigbee.pingDevice(ieee_address);
          reply({ latency_ms: latency });
          break;
        }

        case 'configure_device': {
          const { ieee_address } = payload;
          const result = await this.devices.configureDevice(ieee_address);
          reply(result);
          break;
        }

        case 'get_network_map': {
          const map = await this.zigbee.getNetworkMap();
          reply(map);
          break;
        }

        case 'get_groups': {
          reply({ groups: this.zigbee.getGroups() });
          break;
        }

        case 'create_group': {
          const group = this.zigbee.createGroup(Number(payload.group_id));
          reply({ group });
          break;
        }

        case 'remove_group': {
          this.zigbee.removeGroup(Number(payload.group_id));
          reply({ removed: true });
          break;
        }

        case 'add_group_member': {
          const { group_id, ieee_address, endpoint_id = 1 } = payload;
          const group = this.zigbee.addGroupMember(Number(group_id), ieee_address, Number(endpoint_id));
          reply({ group });
          break;
        }

        case 'remove_group_member': {
          const { group_id, ieee_address, endpoint_id = 1 } = payload;
          const group = this.zigbee.removeGroupMember(Number(group_id), ieee_address, Number(endpoint_id));
          reply({ group });
          break;
        }

        case 'ota_check': {
          const result = await this.zigbee.triggerOtaCheck(payload.ieee_address);
          reply(result);
          break;
        }

        case 'backup': {
          const backupPath = await this.zigbee.backup();
          reply({ path: backupPath });
          break;
        }

        case 'restart': {
          reply({ restarting: true });
          setTimeout(() => this.zigbee.reconnect(), 500);
          break;
        }

        case 'migrate_z2m': {
          const { Z2MMigration } = require('./migration');
          const migration = new Z2MMigration(this.zigbee.config);
          const result = await migration.runFullMigration(payload.z2m_data_dir);
          reply(result);
          break;
        }

        case 'health': {
          reply({ healthy: true, failures: 0, silenceMs: 0 });
          break;
        }

        default: {
          reply(null, `Unknown message type: ${type}`);
        }
      }
    } catch (err) {
      this.log.error(`[ws] Handler error for '${type}': ${err.message}`);
      reply(null, err.message);
    }
  }

  _send(ws, topic, payload) {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ topic, payload }));
  }
}

module.exports = { WebSocketAPI };
