'use strict';

/**
 * znp_key_sync.js
 *
 * Pre-start utility for TCP/network ZStack coordinators.
 *
 * Problem this solves
 * -------------------
 * When migrating from Zigbee2MQTT, the imported coordinator_backup.json may
 * be STALE — its network_key.key does not match the coordinator's actual
 * NWK_ACTIVE_KEY_INFO NVRam item.  herdsman compares backup.networkKey vs
 * activeKeyInfo.key in determineStrategy().  When they differ:
 *
 *   configMatchesBackup = true  → herdsman chooses "restoreBackup" strategy
 *   restoreBackup calls beginRestore() which first tries to commission a
 *   random provisioning network (so it can safely wipe NVRam).
 *   bdbStartCommissioning mode=4 returns NOT_PERMITTED because the
 *   coordinator is already coordinating an existing Zigbee network.
 *   Result: "network commissioning timed out" every startup — infinite loop.
 *
 * The exit from this loop is to make backupMatchesAdapter = true by ensuring
 * coordinator_backup.json.network_key.key equals NWK_ACTIVE_KEY_INFO.key.
 *
 * This module connects directly to a TCP ZStack coordinator using a minimal
 * ZNP implementation (no herdsman), reads NWK_ACTIVE_KEY_INFO (NV ID 58),
 * and synchronises:
 *   /data/network_key.json
 *   /data/coordinator_backup.json  →  network_key.key
 *
 * After the sync:
 *   backupMatchesAdapter  = true
 *   configMatchesAdapter  = false (PRECFGKEY was overwritten by a prior
 *                            failed restoreBackup attempt)
 *   forceStartWithInconsistentAdapterConfiguration = true  →  "startup"
 *   → coordinator starts normally using its existing NIB/active key
 *
 * This is intentionally a no-op for USB coordinators (where a serial port
 * path is used) to avoid timing conflicts and serial driver complexity.
 * It is also a no-op on first run (when no coordinator_backup.json exists)
 * so it does not interfere with fresh installs.
 */

const net  = require('net');
const path = require('path');
const fs   = require('fs');
const { getLogger } = require('./logger');
const { isNetworkPort } = require('./config');

/* ── ZNP constants ───────────────────────────────────────────────────────── */
const SOF          = 0xFE;
const TYPE_SREQ    = 0x20;  // cmd0 bits[7:5] = 001
const TYPE_SRSP    = 0x60;  // cmd0 bits[7:5] = 011
const SUB_SYS      = 0x01;  // SYS subsystem

const SYS_PING            = 0x01;
const SYS_OSAL_NV_LENGTH  = 0x13;  // 19
const SYS_OSAL_NV_READ_EXT = 0x1C; // 28

// ZStack NV item IDs (NvItemsIds in zigbee-herdsman)
const NV_NWK_ACTIVE_KEY_INFO = 58; // 0x3A — nwkKeyDescriptor: {seqNum,key[16],...}
const NV_PRECFGKEY           = 98; // 0x62 — raw 16-byte network key

// Byte offset of the 16-byte key inside nwkKeyDescriptor
// ZStack layout: struct { uint8 seqNum; uint8 key[16]; ... }
const NWK_KEY_DESCRIPTOR_KEY_OFFSET = 1;

/* ── Frame helpers ───────────────────────────────────────────────────────── */
function calcFCS(body) {
  return body.reduce((fcs, b) => fcs ^ b, 0);
}

function buildFrame(type, subsystem, cmd, data) {
  const cmd0 = (type | (subsystem & 0x1F)) & 0xFF;
  const body = [data.length, cmd0, cmd, ...data];
  return Buffer.from([SOF, ...body, calcFCS(body)]);
}

const PING_FRAME = buildFrame(TYPE_SREQ, SUB_SYS, SYS_PING, []);

function nvLengthFrame(nvId) {
  return buildFrame(TYPE_SREQ, SUB_SYS, SYS_OSAL_NV_LENGTH, [
    nvId & 0xFF, (nvId >> 8) & 0xFF,
  ]);
}

function nvReadExtFrame(nvId, offset) {
  return buildFrame(TYPE_SREQ, SUB_SYS, SYS_OSAL_NV_READ_EXT, [
    nvId & 0xFF, (nvId >> 8) & 0xFF,
    offset & 0xFF, (offset >> 8) & 0xFF,
  ]);
}

/* ── Frame parser ────────────────────────────────────────────────────────── */
/**
 * Parse all complete ZNP frames out of a running buffer.
 * Returns { frames: Frame[], remainder: Buffer }.
 */
function parseFrames(buf) {
  const frames = [];
  let i = 0;
  while (i < buf.length) {
    // Find SOF
    if (buf[i] !== SOF) { i++; continue; }
    // Need at least SOF + len + cmd0 + cmd1 + FCS = 5 bytes
    if (i + 4 >= buf.length) break;
    const dataLen = buf[i + 1];
    const frameEnd = i + 4 + dataLen; // index of FCS byte
    if (frameEnd >= buf.length) break; // incomplete
    frames.push({
      type: buf[i + 2] & 0xE0,
      sub:  buf[i + 2] & 0x1F,
      cmd:  buf[i + 3],
      data: buf.slice(i + 4, frameEnd),
    });
    i = frameEnd + 1;
  }
  return { frames, remainder: buf.slice(i) };
}

/* ── Low-level ZNP SREQ/SRSP ─────────────────────────────────────────────── */
async function sendSREQ(sock, frame, responseCmd, timeout = 4000) {
  return new Promise((resolve, reject) => {
    let rxBuf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      sock.removeListener('data', onData);
      reject(new Error(`ZNP: no SRSP for cmd 0x${responseCmd.toString(16).padStart(2, '0')} within ${timeout}ms`));
    }, timeout);

    function onData(chunk) {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      const { frames } = parseFrames(rxBuf);
      for (const f of frames) {
        if (f.type === TYPE_SRSP && f.cmd === responseCmd) {
          clearTimeout(timer);
          sock.removeListener('data', onData);
          resolve(f);
        }
      }
    }
    sock.on('data', onData);
    sock.write(frame);
  });
}

/* ── Connect helper ──────────────────────────────────────────────────────── */
async function connectTCP(host, port, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`ZNP: TCP connect to ${host}:${port} timed out`));
    }, timeout);
    sock.connect(port, host, () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/* ── Core: read a 16-byte key from NVRam ─────────────────────────────────── */
/**
 * Read the 16-byte network key from an NV item.
 *
 * @param {net.Socket} sock
 * @param {number} nvId
 * @param {number} keyOffset byte offset of the key field inside the NV item
 * @returns {Buffer|null}  16-byte key, or null on error
 */
async function readKeyFromNVRam(sock, nvId, keyOffset) {
  // 1. Find item length
  const lenResp = await sendSREQ(sock, nvLengthFrame(nvId), SYS_OSAL_NV_LENGTH);
  const itemLen = lenResp.data.readUInt16LE(0);
  if (itemLen < keyOffset + 16) return null;

  // 2. Read the item (ZStack returns up to 127 bytes per read)
  const readResp = await sendSREQ(sock, nvReadExtFrame(nvId, 0), SYS_OSAL_NV_READ_EXT);
  // SRSP structure: [status(1), len(1), data(len)]
  if (readResp.data[0] !== 0x00) return null; // status != SUCCESS
  const dataLen = readResp.data[1];
  if (dataLen < keyOffset + 16) return null;

  return readResp.data.slice(2 + keyOffset, 2 + keyOffset + 16);
}

/* ── File update helpers ─────────────────────────────────────────────────── */
function keyToHex(keyBuf) {
  return keyBuf.toString('hex');
}

function updateNetworkKeyJson(keyFile, keyArray) {
  fs.writeFileSync(keyFile, JSON.stringify(keyArray), 'utf8');
}

/**
 * Update coordinator_backup.json's network_key.key field.
 * Preserves all other fields.
 */
function updateBackupNetworkKey(backupFile, hexKey) {
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

  if (!backup.network_key) backup.network_key = {};
  backup.network_key.key = hexKey;

  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), 'utf8');
}

/* ── Public API ──────────────────────────────────────────────────────────── */
/**
 * Synchronise network_key.json and coordinator_backup.json with the
 * coordinator's actual NWK_ACTIVE_KEY_INFO.
 *
 * Only runs for TCP/network coordinators when a coordinator_backup.json
 * already exists (i.e., after migration or a previous startup).
 *
 * @param {object} config - loaded add-on config
 * @param {object} [log]  - winston logger (optional; falls back to getLogger)
 * @returns {Promise<boolean>} true if sync was performed, false if skipped
 */
async function syncNetworkKey(config, log) {
  log = log || getLogger();

  const backupFile = path.join(config.data_dir, 'coordinator_backup.json');
  const keyFile    = path.join(config.data_dir, 'network_key.json');

  // Only run if coordinator_backup.json already exists
  if (!fs.existsSync(backupFile)) {
    log.debug('[znp_sync] No coordinator_backup.json — skipping key sync (fresh install)');
    return false;
  }

  // Only run for TCP/network coordinators
  if (!isNetworkPort(config.serial_port)) {
    log.debug('[znp_sync] USB coordinator — skipping TCP key sync');
    return false;
  }

  // Parse host:port from tcp://host:port
  const match = config.serial_port.match(/tcp:\/\/([^:]+):(\d+)/i);
  if (!match) {
    log.debug(`[znp_sync] Cannot parse TCP address from ${config.serial_port} — skipping`);
    return false;
  }
  const host = match[1];
  const port = parseInt(match[2], 10);

  log.info('[znp_sync] Reading coordinator active network key from ZNP...');

  let sock;
  try {
    sock = await connectTCP(host, port);

    // Handshake: SYS_PING to confirm ZNP is responding
    await sendSREQ(sock, PING_FRAME, SYS_PING);

    // Read NWK_ACTIVE_KEY_INFO (NV ID 58)
    // nwkKeyDescriptor layout: byte 0 = seqNum, bytes 1-16 = key
    const activeKey = await readKeyFromNVRam(sock, NV_NWK_ACTIVE_KEY_INFO, NWK_KEY_DESCRIPTOR_KEY_OFFSET);

    if (!activeKey) {
      // Fall back: try PRECFGKEY (NV ID 98, raw 16 bytes, no header)
      log.debug('[znp_sync] NWK_ACTIVE_KEY_INFO unreadable — trying PRECFGKEY');
      const precfgKey = await readKeyFromNVRam(sock, NV_PRECFGKEY, 0);
      if (!precfgKey) {
        log.warn('[znp_sync] Could not read network key from coordinator NVRam — skipping sync');
        sock.destroy();
        return false;
      }
      return await applySyncedKey(precfgKey, keyFile, backupFile, log);
    }

    return await applySyncedKey(activeKey, keyFile, backupFile, log);

  } catch (err) {
    log.warn(`[znp_sync] Key sync failed (non-fatal): ${err.message}`);
    if (sock) sock.destroy();
    return false;
  }
}

async function applySyncedKey(keyBuf, keyFile, backupFile, log) {
  const hexKey   = keyToHex(keyBuf);
  const keyArray = Array.from(keyBuf);

  // Check whether files already match — avoid unnecessary writes
  let alreadyInSync = false;
  try {
    const existing = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    const backup   = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    const backupHex = backup?.network_key?.key;
    alreadyInSync = Array.isArray(existing) &&
                    existing.length === 16 &&
                    existing.every((b, i) => b === keyArray[i]) &&
                    backupHex === hexKey;
  } catch (_) { /* ignore — will rewrite */ }

  if (alreadyInSync) {
    log.debug('[znp_sync] Files already in sync with coordinator active key');
    return false;
  }

  updateNetworkKeyJson(keyFile, keyArray);
  updateBackupNetworkKey(backupFile, hexKey);
  log.info(`[znp_sync] Synced coordinator active key to network_key.json and coordinator_backup.json (key starts: ${hexKey.slice(0, 8)}...)`);
  return true;
}

module.exports = { syncNetworkKey };
