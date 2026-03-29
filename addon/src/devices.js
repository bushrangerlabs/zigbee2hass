'use strict';

const zhc       = require('zigbee-herdsman-converters');
const { getLogger } = require('./logger');

/**
 * DeviceManager sits between ZigbeeController and the WebSocket server.
 *
 * Responsibilities:
 *  - Maintain in-memory device state cache
 *  - Translate raw herdsman messages into HA-friendly state payloads
 *    using zigbee-herdsman-converters (exposes)
 *  - Emit 'state_changed' events with full device + state payload
 *  - Track availability per device
 *  - Handle command confirmation (send → wait for state report → resolve/reject)
 */
class DeviceManager {
  /**
   * @param {object} config
   * @param {ZigbeeController} zigbee
   * @param {function} emit  - fn(event, payload)
   */
  constructor(config, zigbee, emit) {
    this.config   = config;
    this.zigbee   = zigbee;
    this.emit     = emit;
    this.log      = getLogger();

    /** @type {Map<string, object>} ieee_address → device definition (from converters) */
    this._definitions = new Map();
    /** @type {Map<string, object>} ieee_address → current state */
    this._state       = new Map();
    /** @type {Map<string, object>} ieee_address → availability metadata */
    this._availability = new Map();
    /** @type {Map<string, {resolve, reject, timer}>} pending command confirmations */
    this._pendingCommands = new Map();

    this._availabilityTimer = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start() {
    // Load definitions for already-paired devices from herdsman database
    for (const rawDevice of this.zigbee.getRawDevices()) {
      const ieee = rawDevice.ieeeAddr;
      if (rawDevice.type === 'Coordinator') continue;
      const definition = this._resolveDefinition(rawDevice);
      if (definition) {
        this._definitions.set(ieee, definition);
        const label = definition.model ?? '(no model name)';
        this.log.info(`[devices] Loaded definition for ${ieee}: ${label}`);
      } else {
        this.log.warn(`[devices] No definition for ${ieee} (modelID=${rawDevice.modelID}) — will retry on interview`);
      }
      if (!this._state.has(ieee)) this._state.set(ieee, {});
      if (!this._availability.has(ieee)) this._availability.set(ieee, { available: true, last_seen: Date.now() });
    }

    const loadedCount = this._definitions.size;
    this.log.info(`[devices] DeviceManager started — ${loadedCount} device(s) loaded from database`);

    // Start availability polling for mains-powered devices
    this._availabilityTimer = setInterval(
      () => this._checkAvailability(),
      this.config.availability_ping_interval * 1000
    );
  }

  stop() {
    if (this._availabilityTimer) {
      clearInterval(this._availabilityTimer);
      this._availabilityTimer = null;
    }
  }

  // ── Device handling ───────────────────────────────────────────────────────

  /**
   * Called when an already-interviewed device announces itself (re-join / power-on).
   * The device is already in herdsman DB; we just need to fire device_ready.
   */
  onDeviceAnnounce(rawDevice) {
    const ieee = rawDevice.ieeeAddr;
    if (rawDevice.type === 'Coordinator') return;

    // Re-run findByDevice in case it wasn't loaded at startup
    if (!this._definitions.has(ieee)) {
      const definition = this._resolveDefinition(rawDevice);
      if (definition) {
        this._definitions.set(ieee, definition);
        this.log.info(`[devices] Definition found on announce for ${ieee}: ${definition.model ?? '(no model name)'}`);
      } else {
        this.log.warn(`[devices] No definition on announce for ${ieee} (modelID=${rawDevice.modelID})`);
      }
    }

    if (!this._state.has(ieee)) this._state.set(ieee, {});
    if (!this._availability.has(ieee)) this._availability.set(ieee, { available: true, last_seen: Date.now() });
    else this._availability.get(ieee).available = true;

    const definition = this._definitions.get(ieee);
    this.log.info(`[devices] Device announced: ${ieee} (${rawDevice.modelID})`);

    this.emit('device_ready', {
      device: this.zigbee.serializeDevice(rawDevice),
      definition: definition ? this._serializeDefinition(definition) : null,
    });
  }

  /**
   * Called when a device successfully completes interview.
   * Look up its definition in zigbee-herdsman-converters and cache it.
   */
  onDeviceInterview(rawDevice) {
    // rawDevice is the herdsman Device instance — required by zhc.findByDevice
    const definition = this._resolveDefinition(rawDevice);
    const ieee = rawDevice.ieeeAddr;

    if (definition) {
      this._definitions.set(ieee, definition);
      this.log.info(`[devices] Definition found for ${ieee}: ${definition.model ?? '(no model name)'} (vendor=${definition.vendor ?? '?'}, exposes=${Array.isArray(definition.exposes) ? definition.exposes.length : typeof definition.exposes})`);
    } else {
      this.log.warn(`[devices] No definition found for ${ieee} (modelID=${rawDevice.modelID})`);
    }
    this._state.set(ieee, {});
    this._availability.set(ieee, { available: true, last_seen: Date.now() });

    this.emit('device_ready', {
      device: this.zigbee.serializeDevice(rawDevice),
      definition: definition ? this._serializeDefinition(definition) : null,
    });
  }

  /**
   * Called on every raw herdsman message.
   * Converts it to a state update using the device's exposes/converters.
   */
  onMessage(msg) {
    const { ieee_address, cluster, data, link_quality, endpoint } = msg;

    // Update last_seen and availability
    const avail = this._availability.get(ieee_address) ?? {};
    avail.last_seen = Date.now();
    if (!avail.available) {
      avail.available = true;
      this.emit('availability_changed', { ieee_address, available: true });
    }
    this._availability.set(ieee_address, avail);

    const definition = this._definitions.get(ieee_address);
    if (!definition) return; // device not yet interviewed

    // Run through converters to get state
    const meta       = { device: this.zigbee.herdsman?.getDeviceByIeeeAddr(ieee_address) };
    const stateUpdate = {};

    for (const converter of definition.fromZigbee ?? []) {
      if (!converter.cluster) continue;
      const clusters = Array.isArray(converter.cluster) ? converter.cluster : [converter.cluster];
      if (!clusters.includes(cluster)) continue;

      try {
        const result = converter.convert(definition, msg, null, {}, meta);
        if (result) Object.assign(stateUpdate, result);
      } catch (err) {
        this.log.debug(`[devices] Converter error for ${ieee_address}: ${err.message}`);
      }
    }

    if (Object.keys(stateUpdate).length === 0) return;

    // Add link quality
    if (link_quality != null) stateUpdate.link_quality = link_quality;

    // Merge into cached state
    const current = this._state.get(ieee_address) ?? {};
    const next    = { ...current, ...stateUpdate };
    this._state.set(ieee_address, next);

    this.emit('state_changed', { ieee_address, state: stateUpdate, full_state: next });

    // Resolve any pending command waiting for confirmation
    this._resolveCommand(ieee_address, stateUpdate);
  }

  onDeviceLeave(ieee_address) {
    this._definitions.delete(ieee_address);
    this._state.delete(ieee_address);
    this._availability.delete(ieee_address);
  }

  // ── State access ──────────────────────────────────────────────────────────

  getState(ieee_address) {
    return this._state.get(ieee_address) ?? {};
  }

  getAllStates() {
    const result = {};
    for (const [addr, state] of this._state) {
      result[addr] = state;
    }
    return result;
  }

  getDefinition(ieee_address) {
    const def = this._definitions.get(ieee_address);
    return def ? this._serializeDefinition(def) : null;
  }

  getAllDefinitions() {
    const result = {};
    for (const [addr, def] of this._definitions) {
      result[addr] = this._serializeDefinition(def);
    }
    return result;
  }

  getAvailability(ieee_address) {
    return this._availability.get(ieee_address) ?? { available: false };
  }

  // ── Commands with confirmation ────────────────────────────────────────────

  /**
   * Send a command to a device and wait for state confirmation.
   * Retries up to config.command_retries times.
   *
   * @param {string} ieee_address
   * @param {object} payload  - e.g. { state: 'ON', brightness: 128 }
   * @returns {Promise<object>} resolved with confirmed state
   */
  async command(ieee_address, payload) {
    const definition = this._definitions.get(ieee_address);
    if (!definition) throw new Error(`No definition for ${ieee_address}`);

    const device = this.zigbee.herdsman?.getDeviceByIeeeAddr(ieee_address);
    if (!device) throw new Error(`Device ${ieee_address} not found`);

    const endpoint = device.endpoints[0];
    if (!endpoint) throw new Error(`No endpoints on ${ieee_address}`);

    const errors = [];

    for (let attempt = 1; attempt <= this.config.command_retries; attempt++) {
      try {
        // Convert HA-style payload to ZCL commands using toZigbee converters
        for (const converter of definition.toZigbee ?? []) {
          const keys = Array.isArray(converter.key) ? converter.key : [converter.key];
          const relevant = Object.keys(payload).filter(k => keys.includes(k));
          if (relevant.length === 0) continue;

          const subPayload = Object.fromEntries(relevant.map(k => [k, payload[k]]));
          const meta       = { message: payload, mapped: definition, endpoint, device };
          const result     = await converter.convertSet(endpoint, converter.key, subPayload, meta);

          if (result?.readAfterWriteTime) {
            await new Promise(r => setTimeout(r, result.readAfterWriteTime));
          }
        }

        // Wait for state confirmation
        const confirmed = await this._waitForConfirmation(ieee_address, payload);
        return confirmed;

      } catch (err) {
        errors.push(err.message);
        this.log.warn(`[devices] Command attempt ${attempt} failed for ${ieee_address}: ${err.message}`);
        if (attempt < this.config.command_retries) {
          await new Promise(r => setTimeout(r, 500 * attempt));
        }
      }
    }

    throw new Error(`Command failed after ${this.config.command_retries} attempts: ${errors.join(' | ')}`);
  }

  // ── Availability polling ───────────────────────────────────────────────────

  async _checkAvailability() {
    const now = Date.now();
    const timeoutMs = this.config.availability_timeout * 1000;

    for (const [ieee_address, avail] of this._availability) {
      const device = this.zigbee.getDevice(ieee_address);
      if (!device) continue;

      const isMainsPowered = device.power_source === 'Mains (single phase)'
                          || device.power_source === 'Mains (3 phase)';
      const isSleeping     = device.type === 'EndDevice' && !isMainsPowered;

      if (isSleeping) {
        // Battery devices: use silence window, don't actively ping
        const silence = now - (avail.last_seen ?? 0);
        if (silence > timeoutMs && avail.available) {
          this.log.debug(`[devices] Battery device ${ieee_address} silent for ${Math.round(silence/1000)}s`);
          avail.available = false;
          this._availability.set(ieee_address, avail);
          this.emit('availability_changed', { ieee_address, available: false });
        }
      } else {
        // Mains devices: actively ping
        try {
          const latency = await this.zigbee.ping(ieee_address);
          avail.last_seen = Date.now();
          if (!avail.available) {
            avail.available = true;
            this._availability.set(ieee_address, avail);
            this.emit('availability_changed', { ieee_address, available: true, latency });
          }
        } catch {
          if (avail.available) {
            avail.available = false;
            this._availability.set(ieee_address, avail);
            this.emit('availability_changed', { ieee_address, available: false });
          }
        }
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _waitForConfirmation(ieee_address, expectedPayload) {
    return new Promise((resolve, reject) => {
      const key   = `${ieee_address}:${Date.now()}`;
      const timer = setTimeout(() => {
        this._pendingCommands.delete(key);
        // Resolve with current state even without explicit confirm
        resolve(this.getState(ieee_address));
      }, this.config.command_timeout);

      this._pendingCommands.set(key, { ieee_address, expectedPayload, resolve, reject, timer });
    });
  }

  _resolveCommand(ieee_address, stateUpdate) {
    for (const [key, pending] of this._pendingCommands) {
      if (pending.ieee_address !== ieee_address) continue;

      const expectKeys = Object.keys(pending.expectedPayload);
      const allConfirmed = expectKeys.every(k => stateUpdate[k] !== undefined);
      if (!allConfirmed) continue;

      clearTimeout(pending.timer);
      this._pendingCommands.delete(key);
      pending.resolve(stateUpdate);
    }
  }

  /**
   * Look up the zhc definition for a raw herdsman Device object.
   * findByDevice() sometimes returns a fingerprint-only stub with no exposes/vendor.
   * When that happens, fall back to matching via rawDevice.modelID through the
   * zigbeeModel arrays in the full definitions list.
   */
  _resolveDefinition(rawDevice) {
    let def = zhc.findByDevice(rawDevice);

    // If findByDevice returned a stub (missing vendor = no real data), upgrade.
    // Also try if findByDevice returned null entirely.
    if ((!def || !def.vendor) && rawDevice.modelID) {
      const allDefs = zhc.definitions ?? [];
      const byModel = allDefs.find(d =>
        (d.zigbeeModel && d.zigbeeModel.includes(rawDevice.modelID)) ||
        d.model === rawDevice.modelID
      );
      if (byModel) {
        this.log.debug(`[devices] Upgraded to full definition via modelID '${rawDevice.modelID}': ${byModel.model}`);
        def = byModel;
      }
    }

    if (def) {
      const exposeType = typeof def.exposes;
      const exposeLen  = Array.isArray(def.exposes) ? def.exposes.length : (exposeType === 'function' ? 'fn' : exposeType);
      this.log.debug(`[devices] Resolved: model=${def.model}, vendor=${def.vendor}, exposes=${exposeLen}`);
    }
    return def ?? null;
  }

  _serializeDefinition(def) {
    // In zhc v25, exposes may be a function that takes (device, options).
    let exposes;
    if (typeof def.exposes === 'function') {
      try { exposes = def.exposes(null, {}) ?? []; } catch { exposes = []; }
    } else {
      exposes = def.exposes ?? [];
    }
    return {
      model:        def.model        ?? null,
      vendor:       def.vendor       ?? null,
      description:  def.description  ?? null,
      exposes,
      supports_ota: !!def.ota,
    };
  }
}

module.exports = { DeviceManager };
