/**
 * Zigbee2HASS Panel — custom HA sidebar panel for managing Zigbee devices.
 *
 * Registers <zigbee2hass-panel> as a HA panel component.
 * Communicates with the integration via HA WebSocket API (hass.callWS).
 * Shows HA entities per device card with live state + toggle/brightness controls.
 */

'use strict';

const DOMAIN = 'zigbee2hass';

class Zigbee2HASSPanel extends HTMLElement {
  // ── HA lifecycle ─────────────────────────────────────────────────────────

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._devices     = [];
      this._haDeviceMap = {};  // ieee_address → HA device_id
      this._haEntityMap = {};  // HA device_id  → [entity_id, ...]
      this._bridgeAvailable = false;
      this._permitJoin      = false;
      this._permitCountdown = 0;
      this._permitJoinTotal = 254;  // full timeout for progress bar calculation
      this._pairingDevices  = new Map(); // ieee_address → {ieee_address, model_id, friendly_name, status}
      this._pairingUnsub    = null;  // HA event unsubscription function
      this._loading = true;
      this._error   = null;
      this._activeTab        = 'devices';
      this._selectedGroupId  = null;
      this._groups           = [];
      this._mapData          = null;  // cached LQI scan result
      this._setup();
      this._fullLoad();
      this._startPolling();
    } else if (hass && prev && hass.states !== prev.states) {
      // HA pushed updated states — update entity values in-place (no DOM tear-down)
      this._updateEntityStates(prev.states);
    }
  }

  disconnectedCallback() {
    this._stopPolling();
    if (this._pjTimer)    { clearInterval(this._pjTimer); this._pjTimer = null; }
    if (this._pairingUnsub) { this._pairingUnsub(); this._pairingUnsub = null; }
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

        /* ── Pairing Modal ── */
        .pj-modal {
          position: fixed;
          inset: 0;
          z-index: 9998;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .pj-modal.hidden { display: none; }
        .pj-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.45);
        }
        .pj-dialog {
          position: relative;
          background: var(--card-background-color, #fff);
          border-radius: 12px;
          padding: 24px;
          max-width: 480px;
          width: calc(100% - 32px);
          box-shadow: 0 8px 32px rgba(0,0,0,0.28);
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-height: 85vh;
          overflow: hidden;
        }
        .pj-dialog-header {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .pj-dot-anim {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #ff9800;
          flex-shrink: 0;
          animation: pulse 1s infinite;
        }
        .pj-dot-anim.pj-dot-closed { background: #9e9e9e; animation: none; }
        .pj-dialog-title {
          flex: 1;
          margin: 0;
          font-size: 1rem;
          font-weight: 600;
          color: var(--primary-text-color, #212121);
        }
        .pj-countdown {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--primary-color, #03a9f4);
          min-width: 42px;
          text-align: right;
        }
        .pj-progress-track {
          height: 4px;
          background: var(--divider-color, #e0e0e0);
          border-radius: 2px;
          overflow: hidden;
        }
        .pj-progress-bar {
          height: 100%;
          background: var(--primary-color, #03a9f4);
          border-radius: 2px;
          transition: width 1s linear;
        }
        .pj-instruction {
          margin: 0;
          font-size: 0.85rem;
          color: var(--secondary-text-color, #757575);
        }
        .pj-device-list {
          flex: 1;
          overflow-y: auto;
          min-height: 80px;
          max-height: 280px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .pj-empty {
          color: var(--secondary-text-color, #9e9e9e);
          font-size: 0.85rem;
          text-align: center;
          padding: 24px 0;
        }
        .pj-device-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          background: var(--secondary-background-color, #f5f5f5);
          border-radius: 6px;
          font-size: 0.82rem;
        }
        .pj-device-ieee {
          font-family: monospace;
          font-size: 0.75rem;
          color: var(--secondary-text-color, #757575);
          flex-shrink: 0;
        }
        .pj-device-model {
          flex: 1;
          font-weight: 500;
          color: var(--primary-text-color, #212121);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pj-badge {
          flex-shrink: 0;
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 0.72rem;
          font-weight: 600;
        }
        .pj-badge-joined       { background: #fff3e0; color: #e65100; }
        .pj-badge-interviewing { background: #e3f2fd; color: #0277bd; }
        .pj-badge-paired       { background: #e8f5e9; color: #2e7d32; }
        .pj-badge-failed       { background: #ffebee; color: #c62828; }
        .pj-footer {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          flex-wrap: wrap;
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
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .device-icon ha-icon { width: 36px; height: 36px; }
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
        .device-ieee {
          font-size: 0.68rem;
          color: var(--secondary-text-color, #bdbdbd);
          font-family: monospace;
          letter-spacing: 0.02em;
          margin-top: 2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .device-img {
          width: 40px;
          height: 40px;
          object-fit: contain;
          border-radius: 4px;
          flex-shrink: 0;
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
          gap: 6px;
          margin-top: 4px;
          flex-wrap: wrap;
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

        /* ── Entity section ── */
        .entities-section {
          border-top: 1px solid var(--divider-color, #e8e8e8);
          padding-top: 8px;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .entities-label {
          font-size: 0.7rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--secondary-text-color, #9e9e9e);
          font-weight: 600;
          margin-bottom: 2px;
        }
        .entity-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 6px;
          border-radius: 6px;
          background: var(--secondary-background-color, #f5f5f5);
        }
        .entity-icon  { font-size: 1rem; flex-shrink: 0; width: 22px; text-align: center; display: flex; align-items: center; justify-content: center; }
        .entity-icon ha-icon { width: 18px; height: 18px; }
        .entity-label {
          flex: 1;
          font-size: 0.82rem;
          color: var(--primary-text-color, #212121);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .entity-state {
          font-size: 0.78rem;
          font-weight: 500;
          color: var(--secondary-text-color, #9e9e9e);
          white-space: nowrap;
          flex-shrink: 0;
        }
        .entity-state.on { color: #ff9800; font-weight: 600; }
        /* Toggle switch */
        .toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
        .toggle input { opacity: 0; width: 0; height: 0; margin: 0; }
        .slider {
          position: absolute; inset: 0;
          background: #ccc;
          border-radius: 20px;
          cursor: pointer;
          transition: background 0.25s;
        }
        .slider:before {
          content: '';
          position: absolute;
          width: 14px; height: 14px;
          left: 3px; bottom: 3px;
          background: #fff;
          border-radius: 50%;
          transition: transform 0.25s;
        }
        .toggle input:checked + .slider { background: var(--primary-color, #03a9f4); }
        .toggle input:checked + .slider:before { transform: translateX(16px); }
        /* Brightness */
        .brightness-row {
          display: flex; align-items: center; gap: 8px;
          padding: 0 6px 4px;
        }
        .brightness-label { font-size: 0.7rem; color: var(--secondary-text-color, #9e9e9e); width: 64px; }
        .brightness-slider {
          flex: 1;
          -webkit-appearance: none;
          height: 4px; border-radius: 2px;
          background: var(--divider-color, #e0e0e0);
          outline: none; cursor: pointer;
        }
        .brightness-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px; height: 14px;
          border-radius: 50%;
          background: var(--primary-color, #03a9f4);
          cursor: pointer;
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

        /* ── Remove device modal ── */
        .rm-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          z-index: 10000;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .rm-dialog {
          background: var(--card-background-color, #fff);
          border-radius: 12px;
          padding: 24px;
          max-width: 420px;
          width: calc(100% - 32px);
          box-shadow: 0 8px 32px rgba(0,0,0,0.28);
        }
        .rm-title {
          font-size: 1.05rem;
          font-weight: 600;
          margin: 0 0 4px;
        }
        .rm-device-name {
          font-size: 0.9rem;
          margin: 0 0 2px;
        }
        .rm-device-ieee {
          font-family: monospace;
          font-size: 0.78rem;
          color: var(--secondary-text-color, #757575);
          margin: 0 0 16px;
        }
        .rm-option {
          border: 1px solid var(--divider-color, #e0e0e0);
          border-radius: 8px;
          padding: 12px 14px;
          margin-bottom: 10px;
          cursor: default;
        }
        .rm-option-title {
          font-weight: 600;
          font-size: 0.88rem;
          margin-bottom: 4px;
        }
        .rm-option-desc {
          font-size: 0.8rem;
          color: var(--secondary-text-color, #757575);
          line-height: 1.4;
        }
        .rm-footer {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 20px;
          flex-wrap: wrap;
        }
        .btn-force-remove {
          background: #b71c1c;
          color: #fff;
          border: none;
          border-radius: 4px;
          padding: 8px 14px;
          font-size: 0.85rem;
          font-weight: 500;
          cursor: pointer;
          transition: filter 0.15s;
        }
        .btn-force-remove:hover { filter: brightness(1.1); }

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

        /* ── Tabs ── */
        .tabs {
          display: flex;
          gap: 4px;
          margin-bottom: 16px;
          border-bottom: 2px solid var(--divider-color, #e0e0e0);
          padding-bottom: 0;
        }
        .tab-btn {
          background: transparent;
          border: none;
          border-bottom: 3px solid transparent;
          border-radius: 0;
          padding: 8px 14px;
          font-size: 0.85rem;
          font-weight: 500;
          color: var(--secondary-text-color, #757575);
          cursor: pointer;
          margin-bottom: -2px;
          transition: color 0.15s, border-color 0.15s;
        }
        .tab-btn:hover { color: var(--primary-text-color, #212121); }
        .tab-btn.active {
          color: var(--primary-color, #03a9f4);
          border-bottom-color: var(--primary-color, #03a9f4);
        }

        /* ── Network map ── */
        .map-wrap {
          background: var(--card-background-color, #fff);
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          padding: 16px;
          overflow: hidden;
        }
        .map-wrap svg { display: block; width: 100%; touch-action: none; cursor: grab; }
        .map-wrap svg:active { cursor: grabbing; }
        .map-node circle { cursor: grab; }
        .map-node circle:active { cursor: grabbing; }
        .map-node text { font-size: 11px; fill: var(--primary-text-color,#212121); pointer-events: none; user-select: none; }
        .map-link { stroke: #bbb; stroke-opacity: 0.7; fill: none; }
        .map-link.strong { stroke: #4caf50; stroke-opacity: 0.9; }
        .map-link.medium { stroke: #ff9800; stroke-opacity: 0.85; }
        .map-link.weak   { stroke: #f44336; stroke-opacity: 0.75; stroke-dasharray: 7 4; }
        .map-legend { display:flex; gap:16px; flex-wrap:wrap; margin-top:10px; font-size:0.78rem; color:var(--secondary-text-color,#757575); }
        .map-legend span { display:flex; align-items:center; gap:4px; }
        .map-legend .dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
        .map-legend .dash { width:18px; height:3px; border-radius:2px; flex-shrink:0; }
        .map-legend .dash-weak { width:18px; height:3px; flex-shrink:0; background: repeating-linear-gradient(90deg,#f44336 0,#f44336 7px,transparent 7px,transparent 11px); }
        .map-hint { font-size:0.72rem; color:var(--secondary-text-color,#9e9e9e); margin-top:6px; }

        /* ── Groups ── */
        .groups-layout { display: grid; grid-template-columns: 260px 1fr; gap: 16px; align-items: start; }
        @media (max-width: 600px) { .groups-layout { grid-template-columns: 1fr; } }
        .group-list-card, .group-detail-card {
          background: var(--card-background-color, #fff);
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          padding: 16px;
        }
        .group-list-card h3, .group-detail-card h3 { margin: 0 0 12px; font-size:0.95rem; font-weight:600; }
        .group-item {
          display: flex; align-items: center; gap: 8px;
          padding: 7px 8px; border-radius: 6px; cursor: pointer;
          font-size: 0.88rem;
        }
        .group-item:hover { background: var(--secondary-background-color, #f5f5f5); }
        .group-item.selected { background: var(--primary-color-light, #e1f5fe); }
        .group-member-row { display:flex; align-items:center; gap:8px; padding:5px 0; font-size:0.85rem; border-bottom:1px solid var(--divider-color,#eee); }
        .group-member-row:last-child { border:none; }
        .new-group-row { display:flex; gap:8px; margin-bottom:10px; }
        .new-group-row input { flex:1; border:1px solid var(--divider-color,#ccc); border-radius:4px; padding:6px 10px; font-size:0.85rem; background:var(--primary-background-color,#fafafa); color:var(--primary-text-color,#212121); }

        /* ── Tools ── */
        .tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
        .tool-card {
          background: var(--card-background-color, #fff);
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          padding: 16px;
        }
        .tool-card h3 { margin:0 0 8px; font-size:0.9rem; font-weight:600; }
        .tool-card p  { margin:0 0 12px; font-size:0.82rem; color:var(--secondary-text-color,#757575); }
        .tool-result { margin-top:8px; font-size:0.8rem; color:var(--secondary-text-color,#888); word-break:break-all; }
      </style>

      <div class="header">
        <h1><ha-icon icon="mdi:zigbee" style="width:28px;height:28px;vertical-align:middle"></ha-icon> Zigbee Network</h1>
        <div class="bridge-status">
          <span class="dot" id="bridge-dot"></span>
          <span id="bridge-label">connecting…</span>
        </div>
        <button class="btn-primary" id="btn-add">＋ Add Device</button>
        <button class="btn-ghost"   id="btn-refresh" title="Refresh">↺</button>
      </div>

      <div class="tabs">
        <button class="tab-btn active" data-tab="devices"><ha-icon icon="mdi:zigbee" style="width:18px;height:18px;vertical-align:middle"></ha-icon> Devices</button>
        <button class="tab-btn" data-tab="map"><ha-icon icon="mdi:map-marker-path" style="width:18px;height:18px;vertical-align:middle"></ha-icon> Network Map</button>
        <button class="tab-btn" data-tab="groups"><ha-icon icon="mdi:account-group" style="width:18px;height:18px;vertical-align:middle"></ha-icon> Groups</button>
        <button class="tab-btn" data-tab="tools"><ha-icon icon="mdi:tools" style="width:18px;height:18px;vertical-align:middle"></ha-icon> Tools</button>
        <button class="tab-btn" data-tab="settings"><ha-icon icon="mdi:cog" style="width:18px;height:18px;vertical-align:middle"></ha-icon> Settings</button>
      </div>

      <div id="pj-banner-container" style="display:none"></div>
      <div id="content"><div class="loading"><div class="spinner"></div>Loading devices…</div></div>

      <div id="pj-modal" class="pj-modal hidden">
        <div class="pj-backdrop" id="pj-backdrop"></div>
        <div class="pj-dialog">
          <div class="pj-dialog-header">
            <span class="pj-dot-anim" id="pj-dot"></span>
            <h2 class="pj-dialog-title" id="pj-title">Network Open for Pairing</h2>
            <span class="pj-countdown" id="pj-countdown">254s</span>
          </div>
          <div class="pj-progress-track">
            <div class="pj-progress-bar" id="pj-progress-bar" style="width:100%"></div>
          </div>
          <p class="pj-instruction">Power on or reset your Zigbee device. New devices will appear below.</p>
          <div class="pj-device-list" id="pj-device-list">
            <div class="pj-empty">Waiting for devices to join…</div>
          </div>
          <div class="pj-footer">
            <button class="btn-danger  btn-sm" id="btn-pj-stop">Stop</button>
            <button class="btn-primary btn-sm" id="btn-pj-extend">Extend</button>
            <button class="btn-ghost   btn-sm" id="btn-pj-hide">Hide</button>
          </div>
        </div>
      </div>

      <div class="toast" id="toast"></div>
    `;

    this.shadowRoot.getElementById('btn-add').addEventListener('click', () => this._openPermitJoin());
    this.shadowRoot.getElementById('btn-refresh').addEventListener('click', () => this._fullLoad());

    // Pairing modal buttons
    this.shadowRoot.getElementById('btn-pj-stop').addEventListener('click',   () => this._closePermitJoin(true));
    this.shadowRoot.getElementById('btn-pj-hide').addEventListener('click',   () => this._closePermitJoin(false));
    this.shadowRoot.getElementById('btn-pj-extend').addEventListener('click', () => this._extendPermitJoin());
    this.shadowRoot.getElementById('pj-backdrop').addEventListener('click',   () => this._closePermitJoin(false));

    this.shadowRoot.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._activeTab = btn.dataset.tab;
        this.shadowRoot.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
        this._renderTabContent();
      });
    });
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async _fullLoad() {
    try {
      const [zigbeeRes, devRegRaw, entRegRaw] = await Promise.all([
        this._hass.callWS({ type: 'zigbee2hass/get_devices' }),
        this._hass.callWS({ type: 'config/device_registry/list' }),
        this._hass.callWS({ type: 'config/entity_registry/list' }),
      ]);

      // HA may return a bare array or a wrapped object depending on version
      const devReg = Array.isArray(devRegRaw) ? devRegRaw : (devRegRaw?.devices ?? []);
      const entReg = Array.isArray(entRegRaw) ? entRegRaw : (entRegRaw?.entities ?? []);

      this._devices         = zigbeeRes.devices ?? [];
      this._bridgeAvailable = zigbeeRes.bridge_available ?? false;
      this._permitJoin      = zigbeeRes.permit_join ?? false;

      // ieee_address → HA device_id
      this._haDeviceMap = {};
      // ieee_address → human name from HA device registry (name_by_user preferred)
      this._haDeviceNameMap = {};
      for (const haDev of devReg) {
        for (const [idDomain, idValue] of (haDev.identifiers ?? [])) {
          if (idDomain === DOMAIN) {
            this._haDeviceMap[idValue]     = haDev.id;
            this._haDeviceNameMap[idValue] = haDev.name_by_user || haDev.name || null;
          }
        }
      }

      // HA device_id → [entity_id, ...]
      this._haEntityMap = {};
      for (const ent of entReg) {
        if (!ent.device_id) continue;
        (this._haEntityMap[ent.device_id] ??= []).push(ent.entity_id);
      }

      console.log('[zigbee2hass] devReg', devReg.length, 'entReg', entReg.length,
        '\nhaDeviceMap', JSON.stringify(this._haDeviceMap),
        '\ndevice ieee list', this._devices.map(d => d.ieee_address),
        '\ndevReg sample', devReg.slice(0,2).map(d => ({ id: d.id, identifiers: d.identifiers })));

      this._loading = false;
      this._error   = null;
    } catch (err) {
      this._loading = false;
      this._error   = err.message ?? String(err);
    }

    // Ensure a persistent subscription to pairing events is alive for the
    // element's entire lifetime — not just while the modal is open.  This
    // guarantees we hear device_ready even if it fires after the modal was
    // closed (interview can take 30+ seconds after the user hits Stop/Hide).
    if (!this._pairingUnsub) {
      try {
        this._pairingUnsub = await this._hass.connection.subscribeEvents(
          (event) => this._onPairingEvent(event.data),
          'zigbee2hass_pairing_event'
        );
      } catch (_) { /* non-fatal — panel still works without live events */ }
    }

    this._renderAll();
  }

  _startPolling() {
    this._pollTimer = setInterval(() => this._fullLoad(), 15000);
  }

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  // ── Permit Join ───────────────────────────────────────────────────────────

  async _openPermitJoin() {
    const btn = this.shadowRoot.getElementById('btn-add');
    btn.disabled = true;
    try {
      this._permitJoinTotal = 254;
      this._permitCountdown = 254;
      this._pairingDevices  = new Map();

      await this._hass.callWS({ type: 'zigbee2hass/permit_join', permit: true, timeout: 254 });
      this._permitJoin = true;

      // Subscribe to HA bus pairing events — subscription is now managed
      // by _fullLoad() so no need to create it here.

      // Local countdown — keeps UI alive even if permit_join events are delayed
      if (this._pjTimer) clearInterval(this._pjTimer);
      this._pjTimer = setInterval(() => {
        this._permitCountdown = Math.max(0, this._permitCountdown - 1);
        if (this._permitCountdown === 0) {
          this._permitJoin = false;
          clearInterval(this._pjTimer);
          this._pjTimer = null;
        }
        this._updatePairingModal();
      }, 1000);

      this._showPairingModal();
    } catch (err) {
      this._showToast('Failed to open network: ' + (err.message ?? err));
    } finally {
      btn.disabled = false;
    }
  }

  async _extendPermitJoin() {
    try {
      await this._hass.callWS({ type: 'zigbee2hass/permit_join', permit: true, timeout: 254 });
      this._permitJoinTotal = 254;
      this._permitCountdown = 254;
      this._permitJoin = true;
      if (this._pjTimer) clearInterval(this._pjTimer);
      this._pjTimer = setInterval(() => {
        this._permitCountdown = Math.max(0, this._permitCountdown - 1);
        if (this._permitCountdown === 0) {
          this._permitJoin = false;
          clearInterval(this._pjTimer);
          this._pjTimer = null;
        }
        this._updatePairingModal();
      }, 1000);
      this._updatePairingModal();
    } catch (err) {
      this._showToast('Failed to extend: ' + (err.message ?? err));
    }
  }

  async _closePermitJoin(stopNetwork = true) {
    if (this._pjTimer) { clearInterval(this._pjTimer); this._pjTimer = null; }
    // Do NOT unsubscribe from pairing events here — device_ready can fire
    // well after the modal closes and we still need to hear it.
    this._hidePairingModal();
    if (stopNetwork) {
      try {
        await this._hass.callWS({ type: 'zigbee2hass/permit_join', permit: false });
      } catch (err) {
        this._showToast('Failed to close network: ' + (err.message ?? err));
      }
      this._permitJoin = false;
      this._permitCountdown = 0;
    }
    // Refresh device list — newly paired devices will now appear
    await this._fullLoad();
  }

  // ── Pairing modal ─────────────────────────────────────────────────────────

  _showPairingModal() {
    const modal = this.shadowRoot.getElementById('pj-modal');
    if (modal) modal.classList.remove('hidden');
    this._updatePairingModal();
  }

  _hidePairingModal() {
    const modal = this.shadowRoot.getElementById('pj-modal');
    if (modal) modal.classList.add('hidden');
  }

  _onPairingEvent(data) {
    const { type, ieee_address, model_id, friendly_name, status, permit, remaining } = data;

    if (type === 'joined') {
      this._pairingDevices.set(ieee_address, {
        ieee_address,
        model_id:      model_id || null,
        friendly_name: friendly_name || null,
        status: 'joined',
      });
    } else if (type === 'interview') {
      const d = this._pairingDevices.get(ieee_address) || { ieee_address, model_id: model_id || null, friendly_name: null };
      d.status = status === 'started' ? 'interviewing' : 'failed';
      if (model_id) d.model_id = model_id;
      this._pairingDevices.set(ieee_address, d);
    } else if (type === 'ready') {
      const d = this._pairingDevices.get(ieee_address) || { ieee_address, model_id: model_id || null, friendly_name: friendly_name || null };
      d.status = 'paired';
      if (model_id)      d.model_id      = model_id;
      if (friendly_name) d.friendly_name = friendly_name;
      this._pairingDevices.set(ieee_address, d);
      // HA has just created entities for this device — rebuild the entity map
      // so the card shows them immediately without waiting for the 15 s poll.
      // Delay slightly to give HA entity registry time to commit the new entries.
      clearTimeout(this._entityMapRefreshTimer);
      this._entityMapRefreshTimer = setTimeout(() => this._fullLoad(), 2000);
    } else if (type === 'permit_join') {
      this._permitJoin = permit;
      // Server reports remaining seconds via 'remaining' (or ZHC raw 'timeout')
      if (typeof remaining === 'number' && remaining >= 0) {
        this._permitCountdown = remaining;
        // Keep total accurate for progress bar (only on first grant)
        if (permit && remaining > this._permitCountdown) this._permitJoinTotal = remaining;
      }
      if (!permit) {
        if (this._pjTimer) { clearInterval(this._pjTimer); this._pjTimer = null; }
      }
    }

    this._updatePairingModal();
  }

  _updatePairingModal() {
    const modal = this.shadowRoot.getElementById('pj-modal');
    if (!modal || modal.classList.contains('hidden')) return;

    // Dot + title
    const dot   = modal.querySelector('#pj-dot');
    const title = modal.querySelector('#pj-title');
    if (dot)   dot.classList.toggle('pj-dot-closed', !this._permitJoin);
    if (title) title.textContent = this._permitJoin ? 'Network Open for Pairing' : 'Network Closed';

    // Countdown label
    const cd = modal.querySelector('#pj-countdown');
    if (cd) cd.textContent = this._permitJoin ? `${this._permitCountdown}s` : 'closed';

    // Progress bar
    const bar = modal.querySelector('#pj-progress-bar');
    if (bar) {
      const pct = this._permitJoin && this._permitJoinTotal > 0
        ? Math.max(0, (this._permitCountdown / this._permitJoinTotal) * 100)
        : 0;
      bar.style.width = `${pct}%`;
    }

    // Device list
    const list = modal.querySelector('#pj-device-list');
    if (!list) return;
    if (this._pairingDevices.size === 0) {
      list.innerHTML = '<div class="pj-empty">Waiting for devices to join…</div>';
      return;
    }
    const badgeMap = {
      joined:       { cls: 'pj-badge-joined',       label: 'Joining…' },
      interviewing: { cls: 'pj-badge-interviewing',  label: 'Interviewing…' },
      paired:       { cls: 'pj-badge-paired',        label: '✓ Paired' },
      failed:       { cls: 'pj-badge-failed',        label: '✗ Failed' },
    };
    list.innerHTML = [...this._pairingDevices.values()].map(d => {
      const badge = badgeMap[d.status] || badgeMap.joined;
      const name  = d.friendly_name || d.model_id || 'Unknown device';
      const ieee  = d.ieee_address ? `…${this._escHtml(d.ieee_address.slice(-8))}` : '?';
      return `
        <div class="pj-device-item">
          <span class="pj-device-ieee">${ieee}</span>
          <span class="pj-device-model">${this._escHtml(name)}</span>
          <span class="pj-badge ${badge.cls}">${badge.label}</span>
        </div>`;
    }).join('');
  }

  _renderPermitBanner() { /* no-op — replaced by _updatePairingModal */ }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _renderAll() {
    this._updateBridgeStatus();
    this._renderPermitBanner();
    this._renderTabContent();
  }

  _renderTabContent() {
    const tab = this._activeTab ?? 'devices';
    if (tab === 'devices') this._renderDevices();
    else if (tab === 'map')      this._renderNetworkMap();
    else if (tab === 'groups')   this._renderGroups();
    else if (tab === 'tools')    this._renderTools();
    else if (tab === 'settings') this._renderSettings();
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
      const endCount  = this._devices.filter(d => d.type !== 'Coordinator').length;
      const mapCount  = Object.keys(this._haDeviceMap ?? {}).length;
      // Only count entities that belong to Zigbee devices (not all HA entities)
      const zigbeeDevIds = new Set(Object.values(this._haDeviceMap ?? {}));
      const entCount  = Object.entries(this._haEntityMap ?? {})
        .filter(([devId]) => zigbeeDevIds.has(devId))
        .reduce((s, [, ids]) => s + ids.length, 0);
      label.textContent = `online — ${endCount} device${endCount !== 1 ? 's' : ''} · ${mapCount} mapped · ${entCount} entities`;
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

    content.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const { action, ieee } = el.dataset;
        if (action === 'ping')         this._pingDevice(ieee, el);
        if (action === 'configure')    this._configureDevice(ieee, el);
        if (action === 'ota')          this._otaCheck(ieee, el);
        if (action === 'remove')       this._removeDevice(ieee);
        if (action === 'repair')       this._repairDevice(ieee, el);
        if (action === 'rename-start') this._startRename(ieee);
      });
    });

    // Toggle switches
    content.querySelectorAll('input[data-toggle-entity]').forEach(input => {
      input.addEventListener('change', e => {
        e.stopPropagation();
        this._toggleEntity(input.dataset.toggleEntity, input.checked);
      });
    });

    // Brightness sliders
    content.querySelectorAll('input[data-brightness-entity]').forEach(slider => {
      slider.addEventListener('change', e => {
        e.stopPropagation();
        this._setBrightness(slider.dataset.brightnessEntity, parseInt(slider.value));
      });
    });
  }

  _cardHtml(d) {
    const icon       = this._deviceIcon(d);
    const imgUrl     = this._deviceImageUrl(d);
    const avail      = d.available ? 'online' : 'offline';
    const lqi        = d.state?.link_quality ?? null;
    const battery    = d.state?.battery ?? null;
    const action     = d.state?.action ?? null;
    const vendor     = d.definition?.vendor ?? '';
    const model      = d.definition?.model ?? d.model_id ?? '';
    const name = this._escHtml(
      (this._haDeviceNameMap?.[d.ieee_address] || d.friendly_name) ?? d.model_id ?? d.ieee_address
    );
    const ieee       = this._escHtml(d.ieee_address);
    const incomplete = !d.interview_completed ? '<ha-icon icon="mdi:alert-outline" style="width:16px;height:16px;vertical-align:middle;color:var(--warning-color,orange)"></ha-icon> ' : '';
    const metaParts  = [vendor, model].filter(Boolean);
    const meta       = this._escHtml(metaParts.join(' — '));
    const lastSeen   = d.last_seen ? this._relativeTime(d.last_seen) : '—';
    const iconHtml   = imgUrl
      ? `<img class="device-img" src="${this._escHtml(imgUrl)}" alt=""
             onerror="this.style.display='none';this.nextElementSibling.style.display=''">
         <span style="display:none">${icon}</span>`
      : icon;

    const lqiHtml = lqi != null ? `
      <span class="stat" title="Link quality: ${lqi}/255">
        ${this._lqiBars(lqi)}
        ${lqi}
      </span>` : '';

    const battHtml = battery != null ? `
      <span class="stat" title="Battery"><ha-icon icon="mdi:battery" style="width:14px;height:14px;vertical-align:middle"></ha-icon> ${battery}%</span>` : '';

    const actionHtml = action ? `
      <span class="stat"><span class="action-chip" title="Last action">${this._escHtml(String(action))}</span></span>` : '';
    const entityHtml = this._entitiesHtml(d.ieee_address);

    return `
      <div class="card ${d.available ? '' : 'unavailable'}" data-ieee="${ieee}">
        <span class="avail-dot ${avail}" title="${avail}"></span>
        <div class="card-top">
          <div class="device-icon">${iconHtml}</div>
          <div class="device-info">
            <div class="device-name"
                 title="Click to rename"
                 data-action="rename-start"
                 data-ieee="${ieee}"
                 id="name-${ieee.replace(/x|:/g,'')}">${incomplete}${name}</div>
            <div class="device-meta">${meta}</div>
            <div class="device-ieee">${ieee}</div>
          </div>
        </div>
        <div class="stats">
          ${lqiHtml}${battHtml}
          <span class="stat" title="Last seen">🕐 ${lastSeen}</span>
          ${actionHtml}
        </div>
        ${entityHtml}
        <div class="actions">
          <button class="btn-ghost btn-sm" data-action="ping"      data-ieee="${ieee}" title="Ping device">Ping</button>
          <button class="btn-ghost btn-sm" data-action="configure" data-ieee="${ieee}" title="Reconfigure attribute reporting">Configure</button>
          ${d.definition?.supports_ota ? `<button class="btn-ghost btn-sm" data-action="ota" data-ieee="${ieee}" title="Check for OTA firmware update">OTA</button>` : ''}
          <button class="btn-ghost btn-sm" data-action="repair"    data-ieee="${ieee}" title="Recreate HA entities for this device">Repair</button>
          <button class="btn-danger btn-sm" data-action="remove"   data-ieee="${ieee}" title="Remove device">Remove</button>
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

  _entitiesHtml(ieee) {
    const haDeviceId = this._haDeviceMap?.[ieee];
    if (!haDeviceId) {
      // Device not yet in HA registry — show nothing (happens before first entity created)
      return '';
    }
    const entityIds = this._haEntityMap?.[haDeviceId] ?? [];
    if (!entityIds.length) {
      return `<div class="entities-section"><div class="entity-row" style="opacity:0.5;font-style:italic;font-size:0.75rem;">No HA entities linked</div></div>`;
    }
    const rows = entityIds.map(eid => {
      const s = this._hass?.states?.[eid];
      const domain     = eid.split('.')[0];
      const friendlyName = s?.attributes?.friendly_name ?? eid;
      const isOn       = s?.state === 'on';
      const isUnavail  = !s || s.state === 'unavailable';
      const stateLabel = this._formatStateLabel(domain, s);
      const icon       = this._entityIcon(domain, s);
      const nameHtml   = `<span class="entity-label" title="${this._escHtml(eid)}">${this._escHtml(friendlyName)}</span>`;
      const stateHtml  = `<span class="entity-state ${isOn ? 'on' : ''}" data-entity-state="${this._escHtml(eid)}">${this._escHtml(stateLabel)}</span>`;

      let controlHtml = '';
      if (s && (domain === 'light' || domain === 'switch' || domain === 'automation') && !isUnavail) {
        controlHtml = `
          <label class="toggle" title="Toggle">
            <input type="checkbox" data-toggle-entity="${this._escHtml(eid)}" ${isOn ? 'checked' : ''}>
            <span class="slider"></span>
          </label>`;
      }
      let brightnessHtml = '';
      if (s && domain === 'light' && isOn && s.attributes?.brightness != null) {
        const pct = Math.round((s.attributes.brightness / 255) * 100);
        brightnessHtml = `
          <div class="brightness-row">
            <span class="brightness-label">Brightness</span>
            <input class="brightness-slider" type="range" min="1" max="100" value="${pct}"
                   data-brightness-entity="${this._escHtml(eid)}">
          </div>`;
      }

      return `
        <div class="entity-row">
          <span class="entity-icon">${icon}</span>
          ${nameHtml}${stateHtml}${controlHtml}
        </div>${brightnessHtml}`;
    }).join('');
    return rows ? `<div class="entities-section">${rows}</div>` : '';
  }

  _toggleEntity(entityId, turnOn) {
    const domain  = entityId.split('.')[0];
    const service = turnOn ? 'turn_on' : 'turn_off';
    this._hass.callService(domain, service, {}, { entity_id: entityId });
  }

  _setBrightness(entityId, pct) {
    this._hass.callService('light', 'turn_on', { brightness_pct: pct }, { entity_id: entityId });
  }

  _entityIcon(domain, stateObj) {
    const dc = stateObj?.attributes?.device_class;
    const i = (icon) => `<ha-icon icon="${icon}"></ha-icon>`;
    if (domain === 'light')         return i('mdi:lightbulb');
    if (domain === 'switch')        return i('mdi:power-socket');
    if (domain === 'cover')         return i('mdi:window-shutter');
    if (domain === 'climate')       return i('mdi:thermostat');
    if (domain === 'lock')          return i('mdi:lock');
    if (domain === 'alarm_control_panel') return i('mdi:shield-home');
    if (domain === 'automation')    return i('mdi:robot');
    if (domain === 'binary_sensor') {
      if (dc === 'motion' || dc === 'occupancy') return i('mdi:motion-sensor');
      if (dc === 'door' || dc === 'window' || dc === 'contact') return i('mdi:door');
      if (dc === 'smoke')   return i('mdi:smoke-detector');
      if (dc === 'battery') return i('mdi:battery');
      return i('mdi:checkbox-blank-circle-outline');
    }
    if (domain === 'sensor') {
      if (dc === 'battery')     return i('mdi:battery');
      if (dc === 'temperature') return i('mdi:thermometer');
      if (dc === 'humidity')    return i('mdi:water-percent');
      if (dc === 'illuminance') return i('mdi:brightness-5');
      if (dc === 'power')       return i('mdi:lightning-bolt');
      if (dc === 'energy')      return i('mdi:lightning-bolt');
      return i('mdi:chart-line');
    }
    if (domain === 'event')  return i('mdi:gesture-tap-button');
    if (domain === 'button') return i('mdi:gesture-tap-button');
    if (domain === 'device_tracker') return i('mdi:map-marker');
    if (domain === 'update') return i('mdi:update');
    return i('mdi:circle-small');
  }

  _deviceIcon(d) {
    const i = (icon) => `<ha-icon icon="${icon}"></ha-icon>`;
    if (!d.definition?.exposes) return i('mdi:help-circle-outline');
    const exposes = d.definition.exposes;
    const names   = exposes.flatMap(e => [e.type, e.name, ...(e.features?.map(f => f.name) ?? [])]);
    if (names.includes('light') || names.includes('brightness') || names.includes('color_temp')) return i('mdi:lightbulb');
    if (names.includes('position') || names.includes('tilt'))  return i('mdi:window-shutter');
    if (names.includes('climate') || names.includes('occupied_heating_setpoint')) return i('mdi:thermostat');
    if (names.includes('lock') || (names.includes('state') && names.includes('lock'))) return i('mdi:lock');
    if (names.includes('occupancy')) return i('mdi:motion-sensor');
    if (names.includes('contact'))   return i('mdi:door');
    if (names.includes('smoke'))     return i('mdi:smoke-detector');
    if (names.includes('action'))    return i('mdi:gesture-tap-button');
    if (names.includes('switch') || names.includes('state')) return i('mdi:power-socket');
    if (d.power_source === 'Battery') return i('mdi:battery');
    return i('mdi:devices');
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
    const dev  = this._devices.find(d => d.ieee_address === ieee);
    const name = dev?.friendly_name ?? dev?.model_id ?? ieee;
    const choice = await this._showRemoveDeviceDialog(ieee, name);
    if (!choice) return;
    try {
      await this._hass.callWS({
        type:         'zigbee2hass/remove_device',
        ieee_address: ieee,
        force:        choice === 'force',
      });
      this._showToast(choice === 'force' ? 'Device force-removed from database' : 'Device removed');
      await this._fullLoad();
    } catch (err) {
      this._showToast('Remove failed: ' + (err.message ?? err));
    }
  }

  /** Show a two-option remove dialog; resolves to 'normal', 'force', or null (cancel). */
  _showRemoveDeviceDialog(ieee, name) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'rm-overlay';
      overlay.innerHTML = `
        <div class="rm-dialog">
          <p class="rm-title">Remove Device</p>
          <p class="rm-device-name">${this._escHtml(name)}</p>
          <p class="rm-device-ieee">${this._escHtml(ieee)}</p>
          <div class="rm-option">
            <div class="rm-option-title">Remove</div>
            <div class="rm-option-desc">Sends a leave request to the device, then removes it from the network. Use this when the device is still reachable.</div>
          </div>
          <div class="rm-option">
            <div class="rm-option-title" style="color:#b71c1c">Force Remove</div>
            <div class="rm-option-desc">Removes the device from the database immediately without contacting it. Use when the device is offline, broken, or already replaced by another coordinator.</div>
          </div>
          <div class="rm-footer">
            <button class="btn-ghost" id="rm-cancel">Cancel</button>
            <button class="btn-danger" id="rm-normal">Remove</button>
            <button class="btn-force-remove" id="rm-force">Force Remove</button>
          </div>
        </div>`;
      this.shadowRoot.appendChild(overlay);
      const done = r => { overlay.remove(); resolve(r); };
      overlay.querySelector('#rm-cancel').onclick = () => done(null);
      overlay.querySelector('#rm-normal').onclick = () => done('normal');
      overlay.querySelector('#rm-force').onclick  = () => done('force');
      overlay.addEventListener('click', e => { if (e.target === overlay) done(null); });
    });
  }

  _startRename(ieee) {
    const safeId = ieee.replace(/x|:/g, '');
    const nameEl = this.shadowRoot.getElementById(`name-${safeId}`);
    if (!nameEl) return;
    const current = nameEl.textContent.trim();
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
      // Update local cache so the card shows the new name immediately
      const dev = this._devices.find(d => d.ieee_address === ieee);
      if (dev) dev.friendly_name = name;
      if (this._haDeviceNameMap) this._haDeviceNameMap[ieee] = name;
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
      await this._fullLoad();
    }
  }

  // ── Configure / OTA / Network map / Groups / Tools ─────────────────────────

  async _configureDevice(ieee, btn) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await this._hass.callWS({ type: 'zigbee2hass/configure_device', ieee_address: ieee });
      const msg = res.configured ? '✓ Configured' : `⚠ ${res.reason ?? 'skipped'}`;
      this._showToast(`Configure ${ieee}: ${msg}`);
      btn.textContent = 'Done';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
    } catch (err) {
      this._showToast('Configure failed: ' + (err.message ?? err));
      btn.textContent = 'failed';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
  }

  async _otaCheck(ieee, btn) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await this._hass.callWS({ type: 'zigbee2hass/ota_check', ieee_address: ieee });
      this._showToast(`OTA check triggered for ${ieee} — device will respond shortly`);
      btn.textContent = 'Sent';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
    } catch (err) {
      this._showToast('OTA check failed: ' + (err.message ?? err));
      btn.textContent = 'failed';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
  }

  // ── Network Map ─────────────────────────────────────────────────────────────

  async _loadD3() {
    if (window._z2hD3) return window._z2hD3;
    window._z2hD3 = await import('https://cdn.jsdelivr.net/npm/d3@7/+esm');
    return window._z2hD3;
  }

  async _renderNetworkMap() {
    const content = this.shadowRoot.getElementById('content');
    try {
      const d3 = await this._loadD3();
      if (!this._mapData) {
        // First load or after Rescan — show spinner and do LQI scan
        content.innerHTML = `<div class="map-wrap"><div class="loading"><div class="spinner"></div>Scanning network… (may take a minute on large networks)</div></div>`;
        this._mapData = await this._hass.callWS({ type: 'zigbee2hass/get_network_map' });
      }
      this._drawNetworkMap(content, this._mapData, d3);
    } catch (err) {
      this._mapData = null;  // allow retry
      content.innerHTML = `<div class="error-msg">⚠ Network map failed: ${this._escHtml(err.message ?? String(err))}</div>`;
    }
  }

  _drawNetworkMap(content, map, d3) {
    const { nodes: rawNodes = [], links: rawLinks = [] } = map;
    const W = 860, H = 580, R = 16;

    // Deep-copy so D3 simulation can mutate objects freely
    const nodes = rawNodes.map(n => ({ ...n, id: n.ieee }));
    const links = rawLinks.map(l => ({ source: l.source, target: l.target, lqi: l.lqi }));

    content.innerHTML = `
      <div class="map-wrap">
        <svg id="map-svg" viewBox="0 0 ${W} ${H}" style="height:${H}px">
          <g id="map-root"></g>
        </svg>
        <div class="map-legend">
          <span><span class="dot" style="background:#03a9f4"></span>Coordinator</span>
          <span><span class="dot" style="background:#4caf50"></span>Router</span>
          <span><span class="dot" style="background:#ff9800"></span>End device</span>
          <span><span class="dash" style="background:#4caf50"></span>Strong (&ge;170) — solid</span>
          <span><span class="dash" style="background:#ff9800"></span>Medium (&ge;85) — solid</span>
          <span><span class="dash dash-weak"></span>Weak (&lt;85) — dashed</span>
        </div>
        <div class="map-hint">Drag nodes to reposition &bull; Scroll/pinch to zoom &bull; Drag background to pan</div>
        <div style="margin-top:10px"><button class="btn-ghost btn-sm" id="btn-map-refresh">↺ Rescan</button></div>
      </div>`;

    content.querySelector('#btn-map-refresh')?.addEventListener('click', () => {
      this._mapData = null;  // force re-scan
      this._renderNetworkMap();
    });

    const svgEl  = this.shadowRoot.getElementById('map-svg');
    const rootEl = this.shadowRoot.getElementById('map-root');
    if (!svgEl || !rootEl) return;

    const svg  = d3.select(svgEl);
    const root = d3.select(rootEl);

    // ── Zoom / pan ──────────────────────────────────────────────────────────
    svg.call(
      d3.zoom()
        .scaleExtent([0.2, 6])
        .on('zoom', ev => root.attr('transform', ev.transform))
    );

    // ── Force simulation ───────────────────────────────────────────────────
    const sim = d3.forceSimulation(nodes)
      .force('link',    d3.forceLink(links).id(d => d.id).distance(120).strength(0.5))
      .force('charge',  d3.forceManyBody().strength(-340))
      .force('center',  d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide((d) => (d.type === 'Coordinator' ? R + 6 : R) + 4));

    // ── Links ──────────────────────────────────────────────────────────────
    const linkSel = root.append('g')
      .selectAll('line')
      .data(links)
      .join('line')
        .attr('class', d => 'map-link ' + (d.lqi >= 170 ? 'strong' : d.lqi >= 85 ? 'medium' : 'weak'))
        .attr('stroke-width', d => d.lqi >= 170 ? 3 : d.lqi >= 85 ? 2 : 1.5)
        .each(function(d) { d3.select(this).append('title').text(`LQI: ${d.lqi}`); });

    // ── Nodes ──────────────────────────────────────────────────────────────
    const drag = d3.drag()
      .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; });

    const nodeSel = root.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
        .attr('class', 'map-node')
        .call(drag);

    nodeSel.append('circle')
      .attr('r',            d => d.type === 'Coordinator' ? R + 4 : R)
      .attr('fill',         d => d.type === 'Coordinator' ? '#03a9f4' : d.type === 'Router' ? '#4caf50' : '#ff9800')
      .attr('fill-opacity', 0.88)
      .attr('stroke',       '#fff')
      .attr('stroke-width', 2.5);

    nodeSel.append('text')
      .attr('y',           d => (d.type === 'Coordinator' ? R + 4 : R) + 14)
      .attr('text-anchor', 'middle')
      .each(function(d) {
        const label = d.model ?? d.ieee ?? '';
        const el = d3.select(this);
        // Split long labels at a word boundary into at most 2 lines
        if (label.length <= 14 || !label.includes(' ')) {
          el.text(label);
        } else {
          const words = label.split(' ');
          let split = 1, bestDiff = Infinity, cum = 0;
          for (let i = 0; i < words.length - 1; i++) {
            cum += words[i].length + 1;
            const diff = Math.abs(cum - label.length / 2);
            if (diff < bestDiff) { bestDiff = diff; split = i + 1; }
          }
          el.append('tspan').attr('x', 0).attr('dy', 0).text(words.slice(0, split).join(' '));
          el.append('tspan').attr('x', 0).attr('dy', '1.3em').text(words.slice(split).join(' '));
        }
      });

    nodeSel.append('title')
      .text(d => [d.model, d.type, d.ieee].filter(Boolean).join('\n'));

    // ── Tick ───────────────────────────────────────────────────────────────
    sim.on('tick', () => {
      linkSel
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
    });
  }

  // ── Groups ────────────────────────────────────────────────────────────────

  async _renderGroups() {
    const content = this.shadowRoot.getElementById('content');
    content.innerHTML = `<div class="loading"><div class="spinner"></div>Loading groups…</div>`;
    try {
      const res = await this._hass.callWS({ type: 'zigbee2hass/get_groups' });
      this._groups = res.groups ?? [];
      this._drawGroups(content);
    } catch (err) {
      content.innerHTML = `<div class="error-msg">⚠ ${this._escHtml(err.message ?? String(err))}</div>`;
    }
  }

  _drawGroups(content) {
    const groups = this._groups;
    const selId  = this._selectedGroupId;
    const selGroup = groups.find(g => g.id === selId);
    const devicesByIeee = Object.fromEntries(this._devices.map(d => [d.ieee_address, d]));

    const listHtml = groups.length === 0
      ? '<p style="font-size:0.82rem;color:var(--secondary-text-color,#aaa)">No groups yet.</p>'
      : groups.map(g => `
        <div class="group-item ${g.id === selId ? 'selected' : ''}" data-gid="${g.id}">
          <ha-icon icon="mdi:account-group" style="width:16px;height:16px;vertical-align:middle"></ha-icon> Group ${g.id} <span style="font-size:0.75rem;color:var(--secondary-text-color,#aaa);margin-left:auto">${g.members.length} member${g.members.length !== 1 ? 's' : ''}</span>
        </div>`).join('');

    const detailHtml = selGroup ? `
        <h3>Group ${selGroup.id}</h3>
        <div style="margin-bottom:10px">
          ${selGroup.members.length === 0 ? '<p style="font-size:0.82rem;color:var(--secondary-text-color,#aaa)">No members yet.</p>' : selGroup.members.map(m => {
            const dev = devicesByIeee[m.ieee_address];
            const name = dev?.friendly_name ?? m.ieee_address;
            return `<div class="group-member-row">
              <span style="flex:1">${this._escHtml(name)} <span style="font-size:0.75rem;color:#aaa">ep ${m.endpoint_id}</span></span>
              <button class="btn-danger btn-sm" data-action="grp-remove-member" data-gid="${selGroup.id}" data-ieee="${m.ieee_address}" data-ep="${m.endpoint_id}">✕</button>
            </div>`;
          }).join('')}
        </div>
        <div style="margin-bottom:6px;font-size:0.82rem;font-weight:600">Add device:</div>
        <select id="grp-add-select" style="font-size:0.82rem;padding:5px 8px;border-radius:4px;border:1px solid var(--divider-color,#ccc);background:var(--primary-background-color,#fff);color:var(--primary-text-color,#212121);width:100%;margin-bottom:8px">
          <option value="">— select device —</option>
          ${this._devices.filter(d => d.type !== 'Coordinator').map(d =>
            `<option value="${d.ieee_address}">${this._escHtml(d.friendly_name ?? d.ieee_address)}</option>`).join('')}
        </select>
        <div style="display:flex;gap:8px">
          <button class="btn-primary btn-sm" id="grp-add-btn" data-gid="${selGroup.id}">Add</button>
          <button class="btn-danger btn-sm" id="grp-delete-btn" data-gid="${selGroup.id}">Delete Group</button>
        </div>`
      : '<p style="font-size:0.82rem;color:var(--secondary-text-color,#aaa)">Select a group to manage members.</p>';

    content.innerHTML = `
      <div class="groups-layout">
        <div class="group-list-card">
          <h3>Groups</h3>
          <div class="new-group-row">
            <input id="new-group-id" type="number" min="1" max="65535" placeholder="Group ID (1-65535)">
            <button class="btn-primary btn-sm" id="btn-create-group">＋ Create</button>
          </div>
          <div id="group-list">${listHtml}</div>
        </div>
        <div class="group-detail-card" id="group-detail">${detailHtml}</div>
      </div>`;

    // Events
    content.querySelectorAll('.group-item[data-gid]').forEach(el => {
      el.addEventListener('click', () => {
        this._selectedGroupId = Number(el.dataset.gid);
        this._drawGroups(content);
      });
    });
    content.querySelector('#btn-create-group')?.addEventListener('click', async () => {
      const idInput = content.querySelector('#new-group-id');
      const gid = parseInt(idInput?.value);
      if (!gid || gid < 1 || gid > 65535) { this._showToast('Enter a valid group ID (1–65535)'); return; }
      try {
        await this._hass.callWS({ type: 'zigbee2hass/create_group', group_id: gid });
        this._showToast(`Group ${gid} created`);
        await this._renderGroups();
      } catch (err) { this._showToast('Create failed: ' + (err.message ?? err)); }
    });
    content.querySelectorAll('[data-action="grp-remove-member"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await this._hass.callWS({ type: 'zigbee2hass/remove_group_member', group_id: Number(btn.dataset.gid), ieee_address: btn.dataset.ieee, endpoint_id: Number(btn.dataset.ep) });
          this._showToast('Member removed');
          await this._renderGroups();
        } catch (err) { this._showToast('Remove failed: ' + (err.message ?? err)); }
      });
    });
    content.querySelector('#grp-add-btn')?.addEventListener('click', async (e) => {
      const gid  = Number(e.target.dataset.gid);
      const ieee = content.querySelector('#grp-add-select')?.value;
      if (!ieee) { this._showToast('Select a device first'); return; }
      try {
        await this._hass.callWS({ type: 'zigbee2hass/add_group_member', group_id: gid, ieee_address: ieee });
        this._showToast('Member added');
        await this._renderGroups();
      } catch (err) { this._showToast('Add failed: ' + (err.message ?? err)); }
    });
    content.querySelector('#grp-delete-btn')?.addEventListener('click', async (e) => {
      const gid = Number(e.target.dataset.gid);
      if (!confirm(`Delete group ${gid}?`)) return;
      try {
        await this._hass.callWS({ type: 'zigbee2hass/remove_group', group_id: gid });
        this._selectedGroupId = null;
        this._showToast(`Group ${gid} deleted`);
        await this._renderGroups();
      } catch (err) { this._showToast('Delete failed: ' + (err.message ?? err)); }
    });
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  _renderTools() {
    const content = this.shadowRoot.getElementById('content');
    content.innerHTML = `
      <div class="tools-grid">
        <div class="tool-card">
          <h3>💾 NVRam Backup</h3>
          <p>Save a backup of the coordinator's NVRam to <code>coordinator_backup.json</code>. This file can be used to restore the network after a coordinator replacement.</p>
          <button class="btn-primary" id="btn-backup">Backup Now</button>
          <div class="tool-result" id="backup-result"></div>
        </div>
        <div class="tool-card">
          <h3>ℹ️ About</h3>
          <p>Zigbee2HASS — Zigbee integration for Home Assistant.<br>Devices: ${this._devices.filter(d => d.type !== 'Coordinator').length}</p>
        </div>
      </div>`;

    content.querySelector('#btn-backup')?.addEventListener('click', async (btn) => {
      const b = content.querySelector('#btn-backup');
      const r = content.querySelector('#backup-result');
      b.disabled = true; b.textContent = '…';
      try {
        const res = await this._hass.callWS({ type: 'zigbee2hass/backup' });
        const ts  = new Date().toLocaleTimeString();
        r.textContent = `✓ Saved at ${ts} → ${res.path ?? '(unknown path)'}`;
        this._showToast('NVRam backup complete');
      } catch (err) {
        r.textContent = '⚠ ' + (err.message ?? String(err));
        this._showToast('Backup failed: ' + (err.message ?? err));
      } finally {
        b.disabled = false; b.textContent = 'Backup Now';
      }
    });
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  _renderSettings() {
    const content = this.shadowRoot.getElementById('content');
    content.innerHTML = `
      <div class="tools-grid">
        <div class="tool-card">
          <h3>🔧 Entity Watchdog</h3>
          <p>Periodically checks that every device has its HA entities. Missing entities are automatically recreated. Entities for devices that have left the network are removed.</p>
          <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:0.9rem">
            Interval&nbsp;(minutes):
            <input type="number" id="watchdog-interval" min="1" max="1440" value="10"
                   style="width:72px;padding:4px 6px;border:1px solid var(--divider-color,#e0e0e0);border-radius:4px;background:var(--card-background-color);color:var(--primary-text-color)">
          </label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn-primary" id="btn-save-settings">Save</button>
            <button class="btn-ghost"   id="btn-run-watchdog">Run&nbsp;Now</button>
          </div>
          <div class="tool-result" id="settings-result" style="margin-top:10px"></div>
        </div>
        <div class="tool-card">
          <h3>Import from Zigbee2MQTT</h3>
          <p>Download these files from your Z2M host and upload them here. Your devices will not need to be re-paired.</p>
          <p style="color:var(--warning-color,#f4b400);font-size:0.85rem">Stop Zigbee2MQTT first. The add-on will restart automatically after import.</p>
          <div style="display:grid;gap:10px;margin-bottom:14px;font-size:0.88rem">
            <label style="display:flex;flex-direction:column;gap:4px">
              <span>coordinator_backup.json <span style="color:var(--error-color,#f44336)">(required)</span></span>
              <input type="file" id="z2m-backup" accept=".json" style="color:var(--primary-text-color)">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span>database.db <span style="color:var(--error-color,#f44336)">(required)</span></span>
              <input type="file" id="z2m-database" accept=".db" style="color:var(--primary-text-color)">
            </label>
            <label style="display:flex;flex-direction:column;gap:4px">
              <span>configuration.yaml <em>or</em> devices.yaml <span style="opacity:0.6">(optional — for friendly names)</span></span>
              <input type="file" id="z2m-names" accept=".yaml,.yml" style="color:var(--primary-text-color)">
            </label>
          </div>
          <button class="btn-primary" id="btn-z2m-migrate">Import</button>
          <div class="tool-result" id="z2m-migrate-result" style="margin-top:10px"></div>
        </div>
      </div>`;

    // Populate current value
    this._hass.callWS({ type: 'zigbee2hass/get_settings' }).then(res => {
      const el = content.querySelector('#watchdog-interval');
      if (el) el.value = res.watchdog_interval ?? 10;
    }).catch(() => {});

    content.querySelector('#btn-save-settings')?.addEventListener('click', async () => {
      const btn      = content.querySelector('#btn-save-settings');
      const resEl    = content.querySelector('#settings-result');
      const interval = parseInt(content.querySelector('#watchdog-interval')?.value, 10);
      if (!interval || interval < 1 || interval > 1440) {
        resEl.textContent = '⚠ Interval must be between 1 and 1440 minutes';
        return;
      }
      btn.disabled = true; btn.textContent = '…';
      try {
        await this._hass.callWS({ type: 'zigbee2hass/set_settings', watchdog_interval: interval });
        resEl.textContent = `✓ Saved — watchdog will run every ${interval} min`;
        this._showToast('Settings saved');
      } catch (err) {
        resEl.textContent = '⚠ ' + (err.message ?? String(err));
      } finally {
        btn.disabled = false; btn.textContent = 'Save';
      }
    });

    content.querySelector('#btn-run-watchdog')?.addEventListener('click', async () => {
      const btn   = content.querySelector('#btn-run-watchdog');
      const resEl = content.querySelector('#settings-result');
      btn.disabled = true; btn.textContent = '…';
      try {
        await this._hass.callWS({ type: 'zigbee2hass/run_watchdog' });
        resEl.textContent = '✓ Watchdog check complete — see HA logs for details';
        this._showToast('Watchdog check complete');
      } catch (err) {
        resEl.textContent = '⚠ ' + (err.message ?? String(err));
        this._showToast('Watchdog failed: ' + (err.message ?? err));
      } finally {
        btn.disabled = false; btn.textContent = 'Run\u00a0Now';
      }
    });

    content.querySelector('#btn-z2m-migrate')?.addEventListener('click', async () => {
      const btn      = content.querySelector('#btn-z2m-migrate');
      const resEl    = content.querySelector('#z2m-migrate-result');
      const backupInput   = content.querySelector('#z2m-backup');
      const databaseInput = content.querySelector('#z2m-database');
      const namesInput    = content.querySelector('#z2m-names');

      if (!backupInput?.files?.[0] && !databaseInput?.files?.[0]) {
        resEl.textContent = '⚠ Select at least coordinator_backup.json or database.db';
        return;
      }

      const _readB64 = (file) => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve(r.result.split(',')[1]); // strip 'data:...;base64,'
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const _readText = (file) => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve(r.result);
        r.onerror = reject;
        r.readAsText(file);
      });

      btn.disabled = true; btn.textContent = '…';
      resEl.textContent = 'Reading files…';
      try {
        const backupB64   = backupInput?.files?.[0]   ? await _readB64(backupInput.files[0])   : null;
        const databaseB64 = databaseInput?.files?.[0] ? await _readB64(databaseInput.files[0]) : null;
        const namesText   = namesInput?.files?.[0]    ? await _readText(namesInput.files[0])   : null;

        resEl.textContent = 'Uploading…';
        const r = await this._hass.callWS({
          type:         'zigbee2hass/z2m_migrate_files',
          backup_b64:   backupB64,
          database_b64: databaseB64,
          names_text:   namesText,
        });
        const parts = [];
        if (r.coordinator_backup) parts.push('coordinator backup');
        if (r.database)           parts.push('device database');
        if (r.device_count > 0)   parts.push(`${r.device_count} device name(s)`);
        resEl.textContent = `✓ Imported: ${parts.join(', ') || 'no files applied'}. Add-on restarting…`;
        this._showToast('Z2M import complete — add-on restarting');
      } catch (err) {
        resEl.textContent = '⚠ ' + (err.message ?? String(err));
      } finally {
        btn.disabled = false; btn.textContent = 'Import';
      }
    });
  }

  async _repairDevice(ieee, btn) {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      await this._hass.callWS({ type: 'zigbee2hass/repair_device', ieee_address: ieee });
      this._showToast('Repair triggered for ' + ieee);
      // Reload device list after a short delay so new entities appear
      setTimeout(() => this._fullLoad(), 1500);
    } catch (err) {
      this._showToast('Repair failed: ' + (err.message ?? err));
    } finally {
      btn.disabled = false; btn.textContent = orig;
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

  /**
   * Return the best available image URL for a device.
   * Priority:
   *   1. Blakadder lookup keyed by raw herdsman model_id  (available immediately on join)
  /** Return the device image URL — prefer the one resolved server-side, fall back to constructing from definition.model. */
  _deviceImageUrl(d) {
    if (d.image_url) return d.image_url;
    const model = d.definition?.model;
    if (!model) return '';
    return `https://www.zigbee2mqtt.io/images/devices/${model.replace(/\//g, '-').replace(/\s+/g, '_')}.png`;
  }

  /** Format a HA state value for display in entity rows. */
  _formatStateLabel(domain, s) {
    if (!s)                        return 'disabled';
    if (s.state === 'unavailable') return 'unavail';
    if (s.state === 'unknown')     return '—';
    if (domain === 'binary_sensor' || domain === 'input_boolean') {
      const dc = s.attributes?.device_class ?? '';
      if (s.state === 'on') {
        if (['occupancy', 'motion', 'presence'].includes(dc)) return 'detected';
        if (['door', 'window', 'opening', 'contact'].includes(dc))  return 'open';
        return 'active';
      } else {
        if (['occupancy', 'motion', 'presence'].includes(dc)) return 'clear';
        if (['door', 'window', 'opening', 'contact'].includes(dc))  return 'closed';
        return 'inactive';
      }
    }
    if (domain === 'sensor') {
      const unit = s.attributes?.unit_of_measurement ?? '';
      return unit ? `${s.state}\u2009${unit}` : s.state;
    }
    return s.state;
  }

  /**
   * Update entity state spans in-place when HA pushes state changes.
   * Avoids tearing down/rebuilding device cards (no flicker, keeps focus).
   */
  _updateEntityStates(prevStates) {
    const content = this.shadowRoot.getElementById('content');
    if (!content) return;
    content.querySelectorAll('[data-entity-state]').forEach(span => {
      const eid  = span.dataset.entityState;
      const s    = this._hass?.states?.[eid];
      const prev = prevStates?.[eid];
      if (s === prev) return; // no change for this entity
      const domain     = eid.split('.')[0];
      const isOn       = s?.state === 'on';
      span.textContent = this._formatStateLabel(domain, s);
      span.className   = `entity-state ${isOn ? 'on' : ''}`;
    });
    // Sync toggle switch positions without triggering change events
    content.querySelectorAll('input[data-toggle-entity]').forEach(input => {
      const s = this._hass?.states?.[input.dataset.toggleEntity];
      if (s) input.checked = s.state === 'on';
    });
    // Also refresh the bridge status label (last-seen, entity counts)
    this._updateBridgeStatus();
  }
}

customElements.define('zigbee2hass-panel', Zigbee2HASSPanel);
