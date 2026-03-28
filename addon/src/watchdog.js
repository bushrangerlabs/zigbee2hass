'use strict';

const { getLogger } = require('./logger');

/**
 * Watchdog monitors coordinator health and attempts recovery.
 *
 * It tracks:
 *  - Last message received timestamp
 *  - Coordinator permit-join state
 *  - Number of consecutive failures
 *
 * On failure it escalates:
 *  1. Emit 'warning' event
 *  2. Attempt herdsman reconnect
 *  3. If reconnect fails N times → emit 'coordinator_failed' so server can alert HA
 */
class Watchdog {
  /**
   * @param {object} opts
   * @param {number} opts.silenceThreshold  - ms without any message before acting (default 120s)
   * @param {number} opts.checkInterval     - ms between health checks (default 30s)
   * @param {number} opts.maxFailures       - failures before coordinator_failed event (default 3)
   * @param {function} opts.onReconnect     - async fn() called to attempt reconnect
   * @param {function} opts.onFailed        - fn() called when coordinator is considered dead
   * @param {function} opts.onHealthy       - fn() called when coordinator recovers
   */
  constructor(opts = {}) {
    this.silenceThreshold = opts.silenceThreshold ?? 120_000;
    this.checkInterval    = opts.checkInterval    ?? 30_000;
    this.maxFailures      = opts.maxFailures      ?? 3;
    this.onReconnect      = opts.onReconnect      ?? (() => Promise.resolve());
    this.onFailed         = opts.onFailed         ?? (() => {});
    this.onHealthy        = opts.onHealthy        ?? (() => {});

    this._lastMessageAt   = Date.now();
    this._failures        = 0;
    this._timer           = null;
    this._healthy         = true;
    this._reconnecting    = false;

    this.log = getLogger();
  }

  /** Call this whenever any message is received from the coordinator */
  heartbeat() {
    this._lastMessageAt = Date.now();

    if (!this._healthy) {
      this.log.info('[watchdog] Coordinator recovered — heartbeat received');
      this._healthy   = true;
      this._failures  = 0;
      this.onHealthy();
    }
  }

  start() {
    this.log.info('[watchdog] Started');
    this._timer = setInterval(() => this._check(), this.checkInterval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.log.info('[watchdog] Stopped');
  }

  async _check() {
    const silenceMs = Date.now() - this._lastMessageAt;

    if (silenceMs < this.silenceThreshold) return; // all good

    if (this._reconnecting) return; // already trying

    this._failures++;
    this._healthy = false;

    this.log.warn(`[watchdog] No coordinator message for ${Math.round(silenceMs / 1000)}s (failure ${this._failures}/${this.maxFailures})`);

    if (this._failures >= this.maxFailures) {
      this.log.error('[watchdog] Coordinator considered failed — alerting');
      this.onFailed();
      return;
    }

    // Attempt reconnect
    this._reconnecting = true;
    try {
      this.log.info('[watchdog] Attempting coordinator reconnect...');
      await this.onReconnect();
      this._lastMessageAt = Date.now(); // reset silence clock after reconnect attempt
      this.log.info('[watchdog] Reconnect attempt completed');
    } catch (err) {
      this.log.error(`[watchdog] Reconnect failed: ${err.message}`);
    } finally {
      this._reconnecting = false;
    }
  }

  status() {
    return {
      healthy:      this._healthy,
      failures:     this._failures,
      lastMessageAt: this._lastMessageAt,
      silenceMs:    Date.now() - this._lastMessageAt,
    };
  }
}

module.exports = { Watchdog };
