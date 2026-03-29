/**
 * Zigbee2HASS Panel — custom HA sidebar panel for managing Zigbee devices.
 *
 * Registers <zigbee2hass-panel> as a HA panel component.
 * Communicates with the integration via HA WebSocket API (hass.callWS).
 */

'use strict';

class Zigbee2HASSPanel extends HTMLElement {
  // ── HA lifecycle ────────────────────────────────────────────────────────

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._devices = [];
      this._bridgeAvailable = false;
      this._permitJoin = false;
      this._permitCountdown = 0;
      this._loading = true;
      this._error = null;
      this._setup();
      this._loadDevices();
      this._startPolling();
    }
  }

  disconnectedCallback() {
    this._stopPolling();
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  _setup() {
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 16px;
          background: var(--primary-background-color, #fafafa);
          min-height: 100%;
          box-sizing: border-box;
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
        }

        /* ── Header ── */
        .header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        .header h1 {
          margin: 0;
          font-size: 1.4rem;
          font-weight: 500;
          color: var(--primary-text-color, #212121);
          flex: 1;
        }
        .bridge-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.85rem;
          color: var(--secondary-text-color, #757575);
        }
        .dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          display: inline-block;
          flex-shrink: 0;
        }
        .dot.online  { background: #4caf50; }
        .dot.offline { background: #f44336; }
        .dot.unknown { background: #9e9e9e; }
        .dot.active  { background: #ff9800; animation: pulse 1s infinite; }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }

        /* ── Buttons ── */
        button {
          cursor: pointer;
          border: none;
          border-radius: 4px;
          padding: 8px 14px;
          font-size: 0.85rem;
          font-weight: 500;
          transition: filter 0.15s;
        }
        button:hover { filter: brightness(1.1); }
        button:active { filter: brightness(0.9); }
        button:disabled { opacity: 0.5; cursor: default; }

        .btn-primary {
          background: var(--primary-color, #03a9f4);
          color: #fff;
        }
        .btn-danger {
          background: #f44336;
          color: #fff;
        }
        .btn-ghost {
          background: transparent;
          border: 1px solid var(--divider-color, #e0e0e0);
          color: var(--primary-text-color, #212121);
        }
        .btn-sm {
          padding: 4px 10px;
          font-size: 0.78rem;
        }

        /* ── Permit join banner ── */
        .pj-banner {
          background: var(--primary-color, #03a9f4);
          color: #fff;
          border-radius: 8px;
          padding: 12px 16px;
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 0.9rem;
          animation: pulse-bg 1.2s infinite;
        }
        @keyframes pulse-bg {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.85; }
        }
        .pj-banner .pj-icon { font-size: 1.4rem; }
        .pj-banner .pj-text { flex: 1; }
        .pj-banner .pj-close {
          background: rgba(255,255,255,0.25);
          color: #fff;
          border: none;
          border-radius: 4px;
          padding: 4px 10px;
          cursor: pointer;
          font-size: 0.8rem;
        }

        /* ── Device grid ── */
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 16px;
        }

        /* ── Device card ── */
        .card {
          background: var(--card-background-color, #fff);
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.12);
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          position: relative;
          transition: box-shadow 0.2s;
        }
        .card:hover { box-shadow: 0 4px 10px rgba(0,0,0,0.15); }
        .card.unavailable { opacity: 0.65; }

        .card-top {
          display: flex;
          align-items: flex-start;
          gap: 10px;
        }
        .device-icon {
          font-size: 2rem;
          line-height: 1;
          flex-shrink: 0;
          width: 40px;
          text-align: center;
        }
        .device-info { flex: 1; min-width: 0; }

        .device-name {
          font-size: 0.95rem;
          font-weight: 500;
          color: var(--primary-text-color, #212121);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: pointer;
        }
        .device-name:hover { text-decoration: underline; }
        .device-name-input {
          font-size: 0.95rem;
          font-weight: 500;
          color: var(--primary-text-color, #212121);
          background: var(--input-fill-color, #e8e8e8);
          border: 1px solid var(--primary-color, #03a9f4);
          border-radius: 4px;
          padding: 2px 6px;
          width: 100%;
          box-sizing: border-box;
        }

        .device-meta {
          font-size: 0.78rem;
          color: var(--secondary-text-color, #757575);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* Availability indicator on top-right */
        .avail-dot {
          position: absolute;
          top: 12px;
          right: 12px;
          width: 9px;
          height: 9px;
          border-radius: 50%;
        }
        .avail-dot.online  { background: #4caf50; }
        .avail-dot.offline { background: #f44336; }

        /* ── Stats row ── */
        .stats {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          font-size: 0.8rem;
          color: var(--secondary-text-color, #757575);
        }
        .stat {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        /* LQI bars */
        .lqi-bars {
          display: flex;
          align-items: flex-end;
          gap: 1px;
          height: 14px;
        }
        .lqi-bar {
          width: 4px;
          border-radius: 1px;
          background: #ddd;
        }
        .lqi-bar.lit { background: #4caf50; }

        /* ── Action row ── */
        .actions {
          display: flex;
          gap: 8px;
          margin-top: 4px;
        }

        /* ── Last action chip ── */
        .action-chip {
          background: var(--chip-background-color, #e0e0e0);
          border-radius: 12px;
          padding: 2px 10px;
          font-size: 0.78rem;
          color: var(--primary-text-color, #212121);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 150px;
        }

        /* ── Empty / loading states ── */
        .empty, .loading, .error-msg {
          text-align: center;
          padding: 40px 20px;
          color: var(--secondary-text-color, #757575);
          font-size: 0.95rem;
        }
        .error-msg { color: #f44336; }
        .spinner {
          width: 32px;
          height: 32px;
          border: 3px solid var(--divider-color, #e0e0e0);
          border-top-color: var(--primary-color, #03a9f4);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin: 0 auto 12px;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* ── Toast ── */
        .toast {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(0,0,0,0.8);
          color: #fff;
          padding: 10px 20px;
          border-radius: 20px;
          font-size: 0.85rem;
          pointer-events: none;
          z-index: 9999;
          opacity: 0;
          transition: opacity 0.3s;
        }
        .toast.visible { opacity: 1; }
      </style>

      <div class="header">
        <h1>⚡ Zigbee Network</h1>
        <div class="bridge-status">
          <span class="dot" id="bridge-dot"></span>
          <span id="bridge-label">connecting…</span>
        </div>
        <button class="btn-primary" id="btn-add">＋ Add Device</button>
        <button class="btn-ghost"   id="btn-refresh" title="Refresh">↺</button>
      </div>

      <div id="pj-banner-container"></div>
      <div id="content"><div class="loading"><div class="spinner"></div>Loading devices…</div></div>
      <div class="toast" id="toast"></div>
    `;

    this.shadowRoot.getElementById('btn-add').addEventListener('click', () => this._openPermitJoin());
    this.shadowRoot.getElementById('btn-refresh').addEventListener('click', () => this._loadDevices());
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async _loadDevices() {
    try {
      const res = await this._hass.callWS({ type: 'zigbee2hass/get_devices' });
      this._devices = res.devices ?? [];
      this._bridgeAvailable = res.bridge_available ?? false;
      this._permitJoin = res.permit_join ?? false;
      this._loading = false;
      this._error = null;
    } catch (err) {
      this._loading = false;
      this._error = err.message ?? 'Failed to load devices';
    }
    this._renderAll();
  }

  _startPolling() {
    this._pollTimer = setInterval(() => this._loadDevices(), 10000);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ── Permit Join ───────────────────────────────────────────────────────────

  async _openPermitJoin() {
    const btn = this.shadowRoot.getElementById('btn-add');
    btn.disabled = true;
    try {
      await this._hass.callWS({ type: 'zigbee2hass/permit_join', permit: true, timeout: 254 });
      this._permitCountdown = 254;
      this._permitJoin = true;
      this._renderPermitBanner();
      this._showToast('Network open for pairing (254 s)');
      if (this._pjTimer) clearInterval(this._pjTimer);
      this._pjTimer = setInterval(() => {
        this._permitCountdown = Math.max(0, this._permitCountdown - 1);
        if (this._permitCountdown === 0) {
          this._permitJoin = false;
          clearInterval(this._pjTimer);
          this._pjTimer = null;
        }
        this._renderPermitBanner();
      }, 1000);
    } catch (err) {
      this._showToast('Failed to open network: ' + (err.message ?? err));
    } finally {
      btn.disabled = false;
    }
  }

  async _closePermitJoin() {
    try {
      await this._hass.callWS({ type: 'zigbee2hass/permit_join', permit: false });
      this._permitJoin = false;
      this._permitCountdown = 0;
      if (this._pjTimer) { clearInterval(this._pjTimer); this._pjTimer = null; }
      this._renderPermitBanner();
    } catch (err) {
      this._showToast('Failed to close network: ' + (err.message ?? err));
    }
  }

  _renderPermitBanner() {
    const container = this.shadowRoot.getElementById('pj-banner-container');
    if (!this._permitJoin) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = `
      <div class="pj-banner">
        <span class="pj-icon">📡</span>
        <span class="pj-text">
          <strong>Network open for pairing</strong> — power on or reset your device now.
          Closes in <strong>${this._permitCountdown}s</strong>.
        </span>
        <button class="pj-close" id="btn-pj-close">Close</button>
      </div>
    `;
    container.querySelector('#btn-pj-close').addEventListener('click', () => this._closePermitJoin());
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _renderAll() {
    this._updateBridgeStatus();
    this._renderPermitBanner();
    this._renderDevices();
  }

  _updateBridgeStatus() {
    const dot   = this.shadowRoot.getElementById('bridge-dot');
    const label = this.shadowRoot.getElementById('bridge-label');
    if (this._loading) {
      dot.className = 'dot unknown';
      label.textContent = 'connecting…';
    } else if (this._error) {
      dot.className = 'dot offline';
      label.textContent = 'error';
    } else if (this._bridgeAvailable) {
      dot.className = 'dot online';
      label.textContent = `online — ${this._devices.length} device${this._devices.length !== 1 ? 's' : ''}`;
    } else {
      dot.className = 'dot offline';
      label.textContent = 'bridge offline';
    }
  }

  _renderDevices() {
    const content = this.shadowRoot.getElementById('content');

    if (this._loading) {
      content.innerHTML = '<div class="loading"><div class="spinner"></div>Loading devices…</div>';
      return;
    }
    if (this._error) {
      content.innerHTML = `<div class="error-msg">⚠ ${this._escHtml(this._error)}</div>`;
      return;
    }

    const endDevices = this._devices.filter(d => d.type !== 'Coordinator');

    if (endDevices.length === 0) {
      content.innerHTML = `
        <div class="empty">
          No devices paired yet.<br>
          Click <strong>+ Add Device</strong> and power on your Zigbee device.
        </div>`;
      return;
    }

    content.innerHTML = `<div class="grid">${endDevices.map(d => this._cardHtml(d)).join('')}</div>`;

    // Attach card event handlers
    content.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = el.dataset.action;
        const ieee   = el.dataset.ieee;
        if (action === 'ping')   this._pingDevice(ieee, el);
        if (action === 'remove') this._removeDevice(ieee);
        if (action === 'rename-start') this._startRename(ieee);
      });
    });
  }

  _cardHtml(d) {
    const icon       = this._deviceIcon(d);
    const avail      = d.available ? 'online' : 'offline';
    const lqi        = d.state?.link_quality ?? null;
    const battery    = d.state?.battery ?? null;
    const action     = d.state?.action ?? null;
    const vendor     = d.definition?.vendor ?? '';
    const model      = d.definition?.model ?? d.model_id ?? '';
    const name       = this._escHtml(d.friendly_name ?? d.model_id ?? d.ieee_address);
    const ieee       = this._escHtml(d.ieee_address);
    const incomplete = !d.interview_completed ? '⚠ ' : '';
    const metaParts  = [vendor, model].filter(Boolean);
    const meta       = this._escHtml(metaParts.join(' — ') || d.ieee_address);
    const lastSeen   = d.last_seen ? this._relativeTime(d.last_seen) : '—';

    const lqiHtml = lqi != null ? `
      <span class="stat" title="Link quality: ${lqi}/255">
        ${this._lqiBars(lqi)}
        ${lqi}
      </span>` : '';

    const battHtml = battery != null ? `
      <span class="stat" title="Battery">🔋 ${battery}%</span>` : '';

    const actionHtml = action ? `
      <span class="stat"><span class="action-chip" title="Last action">${this._escHtml(String(action))}</span></span>` : '';

    return `
      <div class="card ${d.available ? '' : 'unavailable'}" data-ieee="${ieee}">
        <span class="avail-dot ${avail}" title="${avail}"></span>
        <div class="card-top">
          <div class="device-icon">${icon}</div>
          <div class="device-info">
            <div class="device-name"
                 title="Click to rename"
                 data-action="rename-start"
                 data-ieee="${ieee}"
                 id="name-${ieee.replace(/x|:/g,'')}">${incomplete}${name}</div>
            <div class="device-meta">${meta}</div>
          </div>
        </div>
        <div class="stats">
          ${lqiHtml}${battHtml}
          <span class="stat" title="Last seen">🕐 ${lastSeen}</span>
          ${actionHtml}
        </div>
        <div class="actions">
          <button class="btn-ghost btn-sm" data-action="ping" data-ieee="${ieee}" title="Ping device">Ping</button>
          <button class="btn-danger btn-sm" data-action="remove" data-ieee="${ieee}" title="Remove device">Remove</button>
        </div>
      </div>`;
  }

  _lqiBars(lqi) {
    const level = lqi >= 192 ? 4 : lqi >= 128 ? 3 : lqi >= 64 ? 2 : 1;
    const bars = [3, 5, 8, 11].map((h, i) =>
      `<div class="lqi-bar ${i < level ? 'lit' : ''}" style="height:${h}px"></div>`
    ).join('');
    return `<span class="lqi-bars">${bars}</span>`;
  }

  _deviceIcon(d) {
    if (!d.definition?.exposes) return '❓';
    const exposes = d.definition.exposes;
    const names   = exposes.flatMap(e => [e.type, e.name, ...(e.features?.map(f => f.name) ?? [])]);
    if (names.includes('light') || names.includes('brightness') || names.includes('color_temp')) return '💡';
    if (names.includes('position') || names.includes('tilt'))  return '🪟';
    if (names.includes('climate') || names.includes('occupied_heating_setpoint')) return '❄️';
    if (names.includes('lock') || names.includes('state') && names.includes('lock')) return '🔐';
    if (names.includes('occupancy')) return '🏃';
    if (names.includes('contact'))   return '🚪';
    if (names.includes('smoke'))     return '🔥';
    if (names.includes('action'))    return '🔘';
    if (names.includes('switch') || names.includes('state')) return '🔌';
    if (d.power_source === 'Battery') return '🔋';
    return '📟';
  }

  // ── Device actions ────────────────────────────────────────────────────────

  async _pingDevice(ieee, btn) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await this._hass.callWS({ type: 'zigbee2hass/ping_device', ieee_address: ieee });
      const ms  = res.latency_ms >= 0 ? `${res.latency_ms} ms` : 'no response';
      this._showToast(`Ping ${ieee}: ${ms}`);
      btn.textContent = ms;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
    } catch (err) {
      this._showToast('Ping failed: ' + (err.message ?? err));
      btn.textContent = 'failed';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
  }

  async _removeDevice(ieee) {
    if (!confirm(`Remove device ${ieee} from the Zigbee network?`)) return;
    try {
      await this._hass.callWS({ type: 'zigbee2hass/remove_device', ieee_address: ieee });
      this._showToast('Device removed');
      await this._loadDevices();
    } catch (err) {
      this._showToast('Remove failed: ' + (err.message ?? err));
    }
  }

  _startRename(ieee) {
    const safeId = ieee.replace(/x|:/g, '');
    const nameEl = this.shadowRoot.getElementById(`name-${safeId}`);
    if (!nameEl) return;
    const current = nameEl.textContent.replace(/^⚠ /, '');
    const input = document.createElement('input');
    input.className = 'device-name-input';
    input.value = current;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const finish = () => {
      const newName = input.value.trim();
      if (newName && newName !== current) {
        this._renameDevice(ieee, newName, input);
      } else {
        input.replaceWith(nameEl);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); finish(); }
      if (e.key === 'Escape') { input.replaceWith(nameEl); }
    });
    input.addEventListener('blur', finish, { once: true });
  }

  async _renameDevice(ieee, name, input) {
    try {
      await this._hass.callWS({ type: 'zigbee2hass/rename_device', ieee_address: ieee, name });
      this._showToast(`Renamed to "${name}"`);
      // Update local cache
      const dev = this._devices.find(d => d.ieee_address === ieee);
      if (dev) dev.friendly_name = name;
      // Replace input with updated name span
      const safeId  = ieee.replace(/x|:/g, '');
      const nameEl  = document.createElement('div');
      nameEl.className = 'device-name';
      nameEl.title  = 'Click to rename';
      nameEl.dataset.action = 'rename-start';
      nameEl.dataset.ieee   = ieee;
      nameEl.id     = `name-${safeId}`;
      nameEl.textContent = name;
      nameEl.addEventListener('click', () => this._startRename(ieee));
      if (input.parentNode) input.replaceWith(nameEl);
    } catch (err) {
      this._showToast('Rename failed: ' + (err.message ?? err));
      // Restore original name label - just re-render
      await this._loadDevices();
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  _showToast(msg) {
    const toast = this.shadowRoot.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('visible');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  }

  _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _relativeTime(ts) {
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 60)   return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }
}

customElements.define('zigbee2hass-panel', Zigbee2HASSPanel);
