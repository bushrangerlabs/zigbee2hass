'use strict';

const fs        = require('fs');
const path      = require('path');
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
    /** @type {Map<string, object>} ieee_address → raw herdsman Device (needed to call exposes functions) */
    this._rawDevices  = new Map();
    /** @type {Map<string, object>} ieee_address → current state */
    this._state       = new Map();
    /** @type {Map<string, object>} ieee_address → availability metadata */
    this._availability = new Map();
    /** @type {Map<string, {resolve, reject, timer}>} pending command confirmations */
    this._pendingCommands = new Map();
    /** @type {Map<string, string>} ieee_address → user-assigned friendly name */
    this._friendlyNames = new Map();
    /** @type {Set<string>} ieee addresses for which device_ready has been emitted */
    this._deviceReadyEmitted = new Set();
    /** @type {Set<string>} ieee addresses configured at least once this session (for configure-on-message dedup) */
    this._configuredThisSession = new Set();
    /** @type {Map<string, NodeJS.Timeout>} "ieee:property" → reset timer for auto-clearing binary states */
    this._occupancyTimers = new Map();

    this._availabilityTimer      = null;
    this._availabilityGraceTimer = null;
    this._statePersistTimer  = null;
    this._stateFile = path.join(config.data_dir ?? '/data', 'device_state.json');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    // Restore state from previous session so entities immediately show their
    // last-known values after an add-on restart instead of going "unknown".
    this._loadPersistedState();

    // Load definitions for already-paired devices from herdsman database
    // findByDevice is async in zhc v25 — resolve all in parallel for speed
    const rawDevices = this.zigbee.getRawDevices().filter(d => d.type !== 'Coordinator');
    const resolved = await Promise.all(
      rawDevices.map(async rawDevice => ({
        rawDevice,
        definition: await this._resolveDefinition(rawDevice),
      }))
    );
    for (const { rawDevice, definition } of resolved) {
      const ieee = rawDevice.ieeeAddr;
      if (definition) {
        this._definitions.set(ieee, definition);
        this._rawDevices.set(ieee, rawDevice);
        const label = definition.model ?? '(no model name)';
        this.log.info(`[devices] Loaded definition for ${ieee}: ${label}`);
      } else {
        this.log.warn(`[devices] No definition for ${ieee} (modelID=${rawDevice.modelID}) — will retry on interview or first message`);
      }
      if (!this._state.has(ieee)) this._state.set(ieee, {});
      if (!this._availability.has(ieee)) this._availability.set(ieee, { available: true, last_seen: Date.now() });
      // Devices present at startup go through the snapshot path — mark them as
      // covered so onMessage doesn't redundantly fire device_ready for them if
      // they already have a definition (entity creation is handled by snapshot).
      if (definition) this._deviceReadyEmitted.add(ieee);
    }

    const loadedCount = this._definitions.size;
    this.log.info(`[devices] DeviceManager started — ${loadedCount} device(s) loaded from database`);

    // Run configure() for all already-paired mains-powered devices.
    // Tuya devices (TS0003 etc.) need a "magic packet" genBasic read on every
    // coordinator startup to trigger proper per-endpoint attribute reporting.
    // Without this, some Tuya devices report ALL endpoints together instead of
    // only the changed endpoint, causing all gangs to appear to toggle at once.
    //
    // IMPORTANT: configure calls are serialised with a 3 s gap between each
    // device (matching ioBroker.zigbee's 5 s approach, Z2M uses 10 s).
    // Firing all at once floods the coordinator's ZCL transmit queue, which
    // causes a cascade of NWK_NO_ROUTE (0xcd / 205) errors during startup even
    // when the mesh is healthy.  EndDevices are skipped entirely at startup —
    // they are likely sleeping and will be configured on their first message
    // (onDeviceAnnounce / onMessage).
    const coordEp = this.zigbee.getCoordinatorEndpoint();
    const CONFIGURE_INTER_DEVICE_DELAY_MS = 3000;

    // Build the list: all non-EndDevice devices that have a configure function.
    // EndDevices are excluded because they are likely sleeping at startup and
    // will be configured on their first incoming message instead.
    // We do NOT filter by powerSource — some routers (e.g. IKEA GU10) may not
    // have powerSource read yet, and the 3 s serial delay already prevents
    // flooding the ZNP transmit queue regardless of device count.
    const toConfigureAtStartup = resolved.filter(({ rawDevice, definition }) => {
      if (!definition || typeof definition.configure !== 'function') return false;
      if (rawDevice.type === 'EndDevice') return false; // skip — sleeping, configure on first message
      return true;
    });

    // Run serially in the background — doesn't block startup.
    (async () => {
      const N = toConfigureAtStartup.length;
      if (N > 0) {
        this.log.info(`[configure] Queued ${N} device(s) for startup configure`);
      }
      let succeeded = 0;
      let failed = 0;
      let skipped = 0;
      for (let i = 0; i < N; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, CONFIGURE_INTER_DEVICE_DELAY_MS));
        const { rawDevice, definition } = toConfigureAtStartup[i];
        const ieee = rawDevice.ieeeAddr;

        // Skip reconfigure if the definition carries an explicit version AND
        // the device was already configured with that version in a previous
        // session.  We only skip when definition.version is defined — most
        // ZHC definitions are versionless, and Tuya devices always need the
        // "magic packet" genBasic read on each coordinator restart regardless.
        const definitionVersion = definition.version ?? null;
        if (definitionVersion && rawDevice.meta?.configured === definitionVersion) {
          this.log.debug(`[configure] ${ieee} (${definition.model ?? '?'}) [${i+1}/${N}] — skipped, already at version ${definitionVersion}`);
          skipped++;
          continue;
        }

        this.log.info(`[configure] Configuring ${ieee} (${definition.model ?? '?'}) [${i+1}/${N}]`);
        try {
          await definition.configure(rawDevice, coordEp, definition);
          // Persist the configured version so we can skip next time
          if (!rawDevice.meta) rawDevice.meta = {};
          if (definitionVersion) rawDevice.meta.configured = definitionVersion;
          rawDevice.save?.();
          this._configuredThisSession.add(ieee); // prevent configure-on-message re-trigger
          succeeded++;
          this.log.info(`[configure] ${ieee} (${definition.model ?? '?'}) [${i+1}/${N}] — OK`);
        } catch (err) {
          failed++;
          this.log.warn(`[configure] ${ieee} (${definition.model ?? '?'}) [${i+1}/${N}] — FAILED: ${err.message}`);
        }
      }
      if (N > 0) {
        const parts = [`${succeeded}/${N} succeeded`];
        if (failed > 0) parts.push(`${failed} failed`);
        if (skipped > 0) parts.push(`${skipped} skipped`);
        this.log.info(`[configure] Startup configure complete — ${parts.join(', ')}`);
      }
    })();

    // Start availability polling for mains-powered devices.
    // Delay the first check by the startup grace period so the Zigbee mesh
    // has time to rebuild routing tables after a coordinator restart.
    // Without this, mains-powered devices lacking a direct coordinator route
    // go unavailable within 60s of startup even when the network key is correct.
    const graceMs = (this.config.startup_grace_period ?? 120) * 1000;
    this.log.info(`[avail] Startup grace period — first availability check in ${graceMs / 1000}s`);
    this._availabilityGraceTimer = setTimeout(() => {
      this._availabilityGraceTimer = null;
      this.log.info('[avail] Grace period expired — starting availability checks');
      this._availabilityTimer = setInterval(
        () => this._checkAvailability(),
        this.config.availability_ping_interval * 1000
      );
      // Run immediately once the grace period expires
      this._checkAvailability();
    }, graceMs);
  }

  stop() {
    if (this._availabilityGraceTimer) {
      clearTimeout(this._availabilityGraceTimer);
      this._availabilityGraceTimer = null;
    }
    if (this._availabilityTimer) {
      clearInterval(this._availabilityTimer);
      this._availabilityTimer = null;
    }
    for (const timer of this._occupancyTimers.values()) clearTimeout(timer);
    this._occupancyTimers.clear();
  }

  // ── Device handling ───────────────────────────────────────────────────────

  /**
   * Called when an already-interviewed device announces itself (re-join / power-on).
   * The device is already in herdsman DB; we just need to fire device_ready.
   */
  async onDeviceAnnounce(rawDevice) {
    const ieee = rawDevice.ieeeAddr;
    if (rawDevice.type === 'Coordinator') return;

    // If the device is joining for the first time and interview is not yet
    // complete, its modelID is often undefined and there is no valid definition.
    // Emitting device_ready with definition=null prevents entity creation and
    // the subsequent real device_ready (with definition) from being handled
    // correctly by some HA versions.
    // Mirrors ioBroker.zigbee: only process announce when interviewState == SUCCESSFUL.
    // onDeviceInterview fires device_ready after a successful interview.
    if (!rawDevice.interviewCompleted) {
      this.log.debug(`[devices] Announce for ${ieee} — interview not complete, deferring device_ready to interview completion`);
      if (!this._state.has(ieee)) this._state.set(ieee, {});
      if (!this._availability.has(ieee)) this._availability.set(ieee, { available: true, last_seen: Date.now() });
      return;
    }

    // Re-run findByDevice in case it wasn't loaded at startup
    if (!this._definitions.has(ieee)) {
      const definition = await this._resolveDefinition(rawDevice);
      if (definition) {
        this._definitions.set(ieee, definition);
        this._rawDevices.set(ieee, rawDevice);
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

    // Auto-configure attribute reporting on announce so the device
    // immediately reports its current state (state-read-on-reconnect).
    // Always reconfigure on announce regardless of version — the device just
    // (re-)joined the mesh, so its reporting binds may have been lost.
    if (definition && typeof definition.configure === 'function') {
      // Clear the persisted version so the startup-configure version check
      // doesn't skip this device on the next restart after an announce.
      if (rawDevice.meta) delete rawDevice.meta.configured;
      try {
        const coordEp = this.zigbee.getCoordinatorEndpoint();
        await definition.configure(rawDevice, coordEp, definition);
        const definitionVersion = definition.version ?? null;
        if (!rawDevice.meta) rawDevice.meta = {};
        if (definitionVersion) rawDevice.meta.configured = definitionVersion;
        rawDevice.save?.();
        this.log.info(`[devices] Auto-configured reporting for ${ieee} on announce`);
      } catch (err) {
        this.log.debug(`[devices] Auto-configure skipped for ${ieee}: ${err.message}`);
      }
    }

    // Only mark as emitted when we have a real definition — if definition is
    // null here, the lazy-resolution path in onMessage can still fire it later.
    if (definition) this._deviceReadyEmitted.add(ieee);
    this.emit('device_ready', {
      device: {
        ...this.zigbee.serializeDevice(rawDevice),
        friendly_name: definition?.model ?? rawDevice.modelID ?? rawDevice.ieeeAddr,
      },
      definition: definition ? this._serializeDefinition(definition, rawDevice) : null,
    });
  }

  /**
   * Called when a device successfully completes interview.
   * Look up its definition in zigbee-herdsman-converters and cache it.
   */
  async onDeviceInterview(rawDevice) {
    // rawDevice is the herdsman Device instance — required by zhc.findByDevice
    const definition = await this._resolveDefinition(rawDevice);
    const ieee = rawDevice.ieeeAddr;

    if (definition) {
      this._definitions.set(ieee, definition);
      this._rawDevices.set(ieee, rawDevice);
      this.log.info(`[devices] Definition found for ${ieee}: ${definition.model ?? '(no model name)'} (vendor=${definition.vendor ?? '?'}, exposes=${Array.isArray(definition.exposes) ? definition.exposes.length : typeof definition.exposes})`);
    } else {
      this.log.warn(`[devices] No definition found for ${ieee} (modelID=${rawDevice.modelID})`);
    }
    this._state.set(ieee, {});
    this._availability.set(ieee, { available: true, last_seen: Date.now() });

    if (definition) this._deviceReadyEmitted.add(ieee);
    this.emit('device_ready', {
      device: {
        ...this.zigbee.serializeDevice(rawDevice),
        friendly_name: definition?.model ?? rawDevice.modelID ?? rawDevice.ieeeAddr,
      },
      definition: definition ? this._serializeDefinition(definition, rawDevice) : null,
    });

    // Run configure() after interview — same as onDeviceAnnounce, needed so
    // e.g. Tuya magic packet is sent as soon as the device is interviewed.
    if (definition && typeof definition.configure === 'function') {
      try {
        const coordEp = this.zigbee.getCoordinatorEndpoint();
        await definition.configure(rawDevice, coordEp, definition);
        this.log.info(`[devices] Post-interview configure succeeded for ${rawDevice.ieeeAddr}`);
      } catch (err) {
        this.log.debug(`[devices] Post-interview configure skipped for ${rawDevice.ieeeAddr}: ${err.message}`);
      }
    }
  }

  /**
   * Called on every raw herdsman message.
   * Converts it to a state update using the device's exposes/converters.
   */
  onMessage(msg) {
    const { ieee_address, cluster, data, link_quality, endpoint_id } = msg;

    const _model = this._definitions.get(ieee_address)?.model ?? '?';
    this.log.debug(`[message] ← ${ieee_address} (${_model}) ${cluster}/${msg.type ?? '?'} ep=${endpoint_id ?? 0} lqi=${link_quality ?? '?'}`);

    // Update last_seen and availability
    const avail = this._availability.get(ieee_address) ?? {};
    avail.last_seen = Date.now();
    if (!avail.available) {
      avail.available = true;
      this.emit('availability_changed', { ieee_address, available: true });
    }
    this._availability.set(ieee_address, avail);

    // Configure-on-first-message for EndDevices (mirrors Z2M / ioBroker behaviour).
    // EndDevices are skipped at startup configure because they are likely sleeping.
    // When they send their first message after startup they are awake, so run
    // configure now if it hasn't been done yet for the current definition version.
    const rawDeviceForConfigure = this._rawDevices.get(ieee_address);
    if (rawDeviceForConfigure && rawDeviceForConfigure.type === 'EndDevice') {
      const defForConfigure = this._definitions.get(ieee_address);
      if (defForConfigure && typeof defForConfigure.configure === 'function') {
        const definitionVersion = defForConfigure.version ?? null;
        // Skip if already configured this session (uses version check when
        // definition has one, otherwise uses the session-level Set to avoid
        // running configure on every single message from the device).
        const alreadyDone = definitionVersion
          ? rawDeviceForConfigure.meta?.configured === definitionVersion
          : this._configuredThisSession.has(ieee_address);
        if (!alreadyDone) {
          const coordEp = this.zigbee.getCoordinatorEndpoint();
          this._configuredThisSession.add(ieee_address); // optimistic — prevents concurrent attempts
          defForConfigure.configure(rawDeviceForConfigure, coordEp, defForConfigure)
            .then(() => {
              if (!rawDeviceForConfigure.meta) rawDeviceForConfigure.meta = {};
              if (definitionVersion) rawDeviceForConfigure.meta.configured = definitionVersion;
              rawDeviceForConfigure.save?.();
              this.log.info(`[devices] Configured ${ieee_address} on first message`);
            })
            .catch(err => {
              this._configuredThisSession.delete(ieee_address); // allow retry on next message
              this.log.debug(`[devices] Configure-on-message skipped for ${ieee_address}: ${err.message}`);
            });
        }
      }
    }

    let definition = this._definitions.get(ieee_address);

    // If we have no definition yet, try to resolve it now — covers the case
    // where findByDevice returned null at startup (e.g. interview incomplete)
    // but succeeds once the device starts sending data.
    if (!definition) {
      const rawDevice = this._rawDevices.get(ieee_address)
                     ?? this.zigbee.herdsman?.getDeviceByIeeeAddr(ieee_address);
      if (rawDevice) {
        this._resolveDefinition(rawDevice).then(def => {
          if (def) {
            this.log.info(`[devices] Late definition resolved for ${ieee_address}: ${def.model ?? '?'}`);
            this._definitions.set(ieee_address, def);
            this._rawDevices.set(ieee_address, rawDevice);
            // Only fire device_ready from the late-resolution path when interview
            // is complete.  Firing before interview completes means herdsman
            // hasn't yet discovered all endpoints, so the serialised definition
            // may have an incomplete endpoint map and produce wrong exposes.
            // onDeviceInterview fires device_ready after successful interview.
            if (!this._deviceReadyEmitted.has(ieee_address) && rawDevice.interviewCompleted) {
              this._deviceReadyEmitted.add(ieee_address);
              this.emit('device_ready', {
                device:     this.zigbee.serializeDevice(rawDevice),
                definition: this._serializeDefinition(def, rawDevice),
              });
            }
          }
        }).catch(() => {});
      }
      return; // still no definition for this message cycle
    }

    // zhc v25 fromZigbee converters expect:
    //   msg.endpoint  = raw herdsman Endpoint (for zclTransactionSequenceNumber etc.)
    //   msg.device    = raw herdsman Device
    //   msg.meta      = { zclTransactionSequenceNumber, ... }  (deduplication)
    // _normalizeMessage now preserves these, so msg is already suitable.
    // We only need to supply the 'meta' argument (converter context).
    const rawDevice = this._rawDevices.get(ieee_address);

    // Build endpoint name → ID map so fromZigbee converters can produce
    // endpoint-specific state keys (e.g. state_left, state_right) for
    // multi-endpoint devices such as the TS0003 3-gang switch.
    // Without endpoint_name in meta the converter emits a bare 'state' key
    // for every endpoint, causing all switch entities to toggle together.
    const endpointNameMap = typeof definition.endpoint === 'function'
      ? (definition.endpoint(rawDevice) ?? {})
      : {};
    // Reverse-lookup: endpoint ID → endpoint name
    const endpointName = endpoint_id != null
      ? (Object.entries(endpointNameMap).find(([, id]) => id === endpoint_id)?.[0] ?? null)
      : null;

    // Some ZHC v25 fromZigbee converters destructure 'publish' from meta
    // (or shadow the positional publish arg with meta.publish). Provide a real
    // publish function so converters can push intermediate state updates.
    const publishState = (partialState) => {
      if (!partialState || typeof partialState !== 'object') return;
      const cur  = this._state.get(ieee_address) ?? {};
      const next = { ...cur, ...partialState };
      this._state.set(ieee_address, next);
      this.emit('state_changed', { ieee_address, state: partialState, full_state: next });
    };

    const meta = {
      device:        rawDevice,
      endpoint:      msg.endpoint,  // raw Endpoint (already in normalized msg)
      endpoint_name: endpointName,  // e.g. 'left' for TS0003 endpoint 1
      logger:        this.log,
      state:         this._state.get(ieee_address) ?? {},
      options:       {},
      publish:       publishState,
    };

    // Run through converters to get state
    const stateUpdate = {};

    for (const converter of definition.fromZigbee ?? []) {
      if (!converter.cluster) continue;
      const clusters = Array.isArray(converter.cluster) ? converter.cluster : [converter.cluster];
      if (!clusters.includes(cluster)) continue;

      // Filter by message type — mirrors zigbee2mqtt receive.ts behaviour.
      // Without this, converters built for 'commandOn'/'commandOff' also fire
      // on 'attributeReport' messages and vice-versa.
      if (converter.type) {
        const types = Array.isArray(converter.type) ? converter.type : [converter.type];
        if (!types.includes(msg.type)) continue;
      }

      // Pass device options from the definition (e.g. disableDefaultResponse)
      // so converters that read options behave the same as in zigbee2mqtt.
      const options = definition.options
        ? Object.fromEntries((definition.options ?? []).map(o => [o.name, o.default ?? undefined]))
        : {};

      try {
        // Pass publishState as both positional publish arg AND meta.publish so
        // converters find it regardless of which calling convention they use.
        const result = converter.convert(definition, msg, publishState, options, meta);
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
    this._schedulePersistState();

    this.emit('state_changed', { ieee_address, state: stateUpdate, full_state: next });

    // Auto-reset occupancy/presence after timeout (these sensors only send
    // "true" — they never send "false" when the area clears)
    const occupancyTimeoutSecs = this.config.occupancy_timeout ?? 90;
    if (occupancyTimeoutSecs > 0) {
      const RESET_PROPERTIES = ['occupancy', 'presence'];
      for (const prop of RESET_PROPERTIES) {
        if (stateUpdate[prop] === true) {
          const key = `${ieee_address}:${prop}`;
          if (this._occupancyTimers.has(key)) clearTimeout(this._occupancyTimers.get(key));
          this._occupancyTimers.set(key, setTimeout(() => {
            this._occupancyTimers.delete(key);
            const cur = this._state.get(ieee_address) ?? {};
            if (cur[prop] !== true) return; // already cleared by a real message
            const reset = { [prop]: false };
            this._state.set(ieee_address, { ...cur, ...reset });
            this.log.debug(`[devices] Auto-cleared ${prop} for ${ieee_address} after ${occupancyTimeoutSecs}s`);
            this.emit('state_changed', { ieee_address, state: reset, full_state: { ...cur, ...reset } });
          }, occupancyTimeoutSecs * 1000));
        }
      }
    }

    // If device_ready was never emitted for this device (e.g. it didn't announce
    // after an addon restart), fire it now on first real state message so HA
    // platforms can create entities.
    if (!this._deviceReadyEmitted.has(ieee_address)) {
      this._deviceReadyEmitted.add(ieee_address);
      const rawDev = this._rawDevices.get(ieee_address);
      this.log.info(`[devices] Firing late device_ready for ${ieee_address} on first message`);
      this.emit('device_ready', {
        device:     rawDev ? this.zigbee.serializeDevice(rawDev) : { ieee_address },
        definition: rawDev ? this._serializeDefinition(definition, rawDev) : null,
      });
    }

    // Resolve any pending command waiting for confirmation
    this._resolveCommand(ieee_address, stateUpdate);
  }

  onDeviceLeave(ieee_address) {
    this._definitions.delete(ieee_address);
    this._rawDevices.delete(ieee_address);
    this._state.delete(ieee_address);
    this._schedulePersistState();
    this._availability.delete(ieee_address);
    this._deviceReadyEmitted.delete(ieee_address);
    // Clear any pending occupancy reset timers for this device
    for (const key of [...this._occupancyTimers.keys()]) {
      if (key.startsWith(`${ieee_address}:`)) {
        clearTimeout(this._occupancyTimers.get(key));
        this._occupancyTimers.delete(key);
      }
    }
  }

  // ── Configure / reconfigure ───────────────────────────────────────────────

  /**
   * Run the ZHC configure() function for a device to set up attribute reporting.
   * This is the same function zigbee2mqtt calls after interview.
   */
  async configureDevice(ieee_address) {
    const rawDevice  = this._rawDevices.get(ieee_address);
    const definition = this._definitions.get(ieee_address);
    if (!rawDevice)  throw new Error(`Device ${ieee_address} not found in cache`);
    if (!definition) throw new Error(`No definition for ${ieee_address}`);
    if (typeof definition.configure !== 'function') {
      return { configured: false, reason: 'no configure function for this device' };
    }
    const coordEp = this.zigbee.getCoordinatorEndpoint();
    await definition.configure(rawDevice, coordEp, definition);
    this.log.info(`[devices] Reconfigured attribute reporting for ${ieee_address}`);
    return { configured: true };
  }

  // ── State persistence ─────────────────────────────────────────────────────

  _loadPersistedState() {
    try {
      if (fs.existsSync(this._stateFile)) {
        const raw = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
        let count = 0;
        for (const [ieee, state] of Object.entries(raw ?? {})) {
          if (typeof state === 'object' && state !== null) {
            // Only seed if not yet populated (herdsman DB takes precedence for empty objects)
            this._state.set(ieee, state);
            count++;
          }
        }
        this.log.info(`[devices] Loaded persisted state for ${count} device(s) from ${this._stateFile}`);
      }
    } catch (e) {
      this.log.warn(`[devices] Could not load persisted state: ${e.message}`);
    }
  }

  _schedulePersistState() {
    if (this._statePersistTimer) return;
    this._statePersistTimer = setTimeout(() => {
      this._statePersistTimer = null;
      try {
        const obj = {};
        for (const [ieee, state] of this._state) {
          obj[ieee] = state;
        }
        fs.writeFileSync(this._stateFile, JSON.stringify(obj, null, 2), 'utf8');
      } catch (e) {
        this.log.warn(`[devices] Could not persist state: ${e.message}`);
      }
    }, 2000); // debounce: coalesce rapid updates into one write
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
    const raw = this._rawDevices.get(ieee_address) ?? null;
    return def ? this._serializeDefinition(def, raw) : null;
  }

  getAllDefinitions() {
    const result = {};
    for (const [addr, def] of this._definitions) {
      const raw = this._rawDevices.get(addr) ?? null;
      result[addr] = this._serializeDefinition(def, raw);
    }
    return result;
  }

  getAvailability(ieee_address) {
    return this._availability.get(ieee_address) ?? { available: false };
  }

  setFriendlyName(ieee_address, name) {
    if (name) {
      this._friendlyNames.set(ieee_address, name);
    } else {
      this._friendlyNames.delete(ieee_address);
    }
  }

  getFriendlyName(ieee_address) {
    return this._friendlyNames.get(ieee_address) ?? null;
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

    const rawDevice = this._rawDevices.get(ieee_address)
                   ?? this.zigbee.herdsman?.getDeviceByIeeeAddr(ieee_address);
    if (!rawDevice) throw new Error(`Device ${ieee_address} not found`);

    // Build endpoint name → ID map for multi-endpoint devices
    // e.g. TS0003 3-gang: definition.endpoint(device) = {left:1, center:2, right:3}
    // HA sends {state_left:'ON'} → we must strip '_left', resolve endpoint 1, send 'state'.
    const endpointNameMap = typeof definition.endpoint === 'function'
      ? (definition.endpoint(rawDevice) ?? {})
      : {};

    // Decompose each payload key into { baseKey, value, endpointId }
    const items = Object.entries(payload).map(([rawKey, value]) => {
      for (const [epName, epId] of Object.entries(endpointNameMap)) {
        if (rawKey.endsWith(`_${epName}`)) {
          return { baseKey: rawKey.slice(0, -(epName.length + 1)), value, endpointId: epId, rawKey };
        }
      }
      return { baseKey: rawKey, value, endpointId: null, rawKey };
    });

    const publishFn = (partialState) => {
      if (!partialState || typeof partialState !== 'object') return;
      const cur  = this._state.get(ieee_address) ?? {};
      const next = { ...cur, ...partialState };
      this._state.set(ieee_address, next);
      this._schedulePersistState();
      this.emit('state_changed', { ieee_address, state: partialState, full_state: next });
    };

    const errors = [];

    const _model2 = this._definitions.get(ieee_address)?.model ?? '?';
    this.log.debug(`[command] → ${ieee_address} (${_model2}) ${JSON.stringify(payload).substring(0, 120)}`);

    for (let attempt = 1; attempt <= this.config.command_retries; attempt++) {
      try {
        let converterRan = false;

        for (const { baseKey, value, endpointId, rawKey } of items) {
          // Resolve the endpoint for this key
          const ep = endpointId != null
            ? (rawDevice.getEndpoint(endpointId) ?? rawDevice.endpoints[0])
            : rawDevice.endpoints[0];
          if (!ep) throw new Error(`No endpoint on ${ieee_address}`);

          // Find the toZigbee converter that handles this base key
          const converter = (definition.toZigbee ?? []).find(tz => {
            const ks = Array.isArray(tz.key) ? tz.key : [tz.key];
            return ks.includes(baseKey);
          });
          if (!converter) {
            this.log.debug(`[devices] No toZigbee converter for '${baseKey}' on ${ieee_address}`);
            continue;
          }

          // Lookup the endpoint name (e.g. 'left') for this endpoint ID.
          // ZHC v25 converters use meta.endpoint_name to build endpoint-specific
          // state keys (e.g. for toggle: state${_left}).
          const endpointName = endpointId != null
            ? (Object.entries(endpointNameMap).find(([, id]) => id === endpointId)?.[0] ?? null)
            : null;

          // Wrap publishFn to remap base-key results back to the original raw key
          // so optimistic state updates stay endpoint-specific.
          // e.g. converter emits {state: 'ON'} → we publish {state_left: 'ON'}
          // preventing the update from bleeding into all endpoint entities.
          const epPublishFn = endpointName != null
            ? (partialState) => {
                if (!partialState || typeof partialState !== 'object') return;
                const remapped = {};
                for (const [k, v] of Object.entries(partialState)) {
                  remapped[k === baseKey ? rawKey : k] = v;
                }
                publishFn(remapped);
              }
            : publishFn;

          // Some ZHC v25 converters read meta.message[baseKey] directly (not the
          // value parameter). For endpoint-remapped keys (e.g. state_left→state)
          // we must ensure meta.message also contains the base key so the
          // converter's validator doesn't receive undefined/null.
          const normalizedMessage = endpointId != null
            ? { ...payload, [baseKey]: value }
            : payload;

          const meta = {
            message:       normalizedMessage,
            mapped:        definition,
            endpoint_name: endpointName,
            endpoint:      ep,
            device:        rawDevice,
            logger:        this.log,
            state:         this._state.get(ieee_address) ?? {},
            options:       {},
            publish:       epPublishFn,
          };

          const result = await converter.convertSet(ep, baseKey, value, meta);
          converterRan = true;

          if (result?.readAfterWriteTime) {
            await new Promise(r => setTimeout(r, result.readAfterWriteTime));
          }
          // Apply state returned by the converter as optimistic update,
          // remapping base key back to the endpoint-specific raw key.
          if (result?.state) { epPublishFn(result.state); }
        }

        if (!converterRan) {
          this.log.warn(`[devices] No toZigbee converter found for payload keys [${Object.keys(payload).join(', ')}] on ${ieee_address}`);
        }

        // Wait for state confirmation (resolves with current state on timeout)
        const confirmed = await this._waitForConfirmation(ieee_address, payload);
        this.log.debug(`[command] ✓ ${ieee_address} (${_model2}) confirmed on attempt ${attempt}`);
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
        // Battery/sleeping devices are silent by design — do not mark them
        // unavailable based on silence. They only go unavailable when the bridge
        // itself disconnects (handled by the WS disconnect path). Marking them
        // unavailable after a silence window causes healthy door sensors, motion
        // sensors, and remotes to appear offline after a quiet evening.
      } else {
        // Mains devices: actively ping the device itself (not just the coordinator)
        const modelLabel = this._definitions.get(ieee_address)?.model ?? device.model_id ?? '?';
        this.log.debug(`[avail] Pinging ${ieee_address} (${modelLabel})`);
        try {
          const latency = await this.zigbee.pingDevice(ieee_address);
          this.log.debug(`[avail] ${ieee_address} (${modelLabel}) — online ${latency}ms`);
          avail.last_seen = Date.now();
          if (!avail.available) {
            avail.available = true;
            this._availability.set(ieee_address, avail);
            this.log.info(`[avail] ${ieee_address} (${modelLabel}) came back online (${latency}ms)`);
            this.emit('availability_changed', { ieee_address, available: true, latency });
          }
        } catch {
          this.log.debug(`[avail] ${ieee_address} (${modelLabel}) — ping failed`);
          if (avail.available) {
            avail.available = false;
            this._availability.set(ieee_address, avail);
            this.log.warn(`[avail] ${ieee_address} (${modelLabel}) went offline`);
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
   * findByDevice() is async in zhc v25 — must be awaited.
   */
  async _resolveDefinition(rawDevice) {
    const def = await zhc.findByDevice(rawDevice);
    if (def) {
      const exposeType = typeof def.exposes;
      const exposeLen  = Array.isArray(def.exposes) ? def.exposes.length : (exposeType === 'function' ? 'fn' : exposeType);
      this.log.debug(`[devices] Resolved: model=${def.model}, vendor=${def.vendor}, exposes=${exposeLen}`);
    }
    return def ?? null;
  }

  _serializeDefinition(def, rawDevice = null) {
    // In zhc v25, exposes may be a function that takes (device, options).
    // Pass the actual herdsman device so it can read endpoints/clusters.
    let exposes;
    if (typeof def.exposes === 'function') {
      try { exposes = def.exposes(rawDevice, {}) ?? []; } catch (e) {
        this.log.warn(`[devices] exposes() threw for ${rawDevice?.modelID ?? '?'}: ${e.message}`);
        exposes = [];
      }
    } else {
      exposes = def.exposes ?? [];
    }
    // Deduplicate exposes — some ZHC v25 definitions (especially with
    // multi-endpoint devices or function-style exposes) can return the same
    // property multiple times, causing duplicate HA entities.
    const seen = new Set();
    const uniqueExposes = exposes.filter(e => {
      const key = `${e.name ?? e.type ?? ''}:${e.property ?? ''}:${e.endpoint ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      model:        def.model        ?? null,
      vendor:       def.vendor       ?? null,
      description:  def.description  ?? null,
      exposes:      uniqueExposes,
      supports_ota: !!def.ota,
    };
  }
}

module.exports = { DeviceManager };
