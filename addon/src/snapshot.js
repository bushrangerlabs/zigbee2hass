'use strict';

/**
 * Pre-start data snapshot utility.
 *
 * Creates a timestamped copy of critical data files (coordinator_backup.json,
 * database.db) before zigbee-herdsman starts each session.
 *
 * Rationale (mirrors ioBroker.zigbee):
 *   herdsman can corrupt database.db on a bad startup (power cut during write,
 *   etc.). The periodic NVRam backup only captures coordinator_backup.json.
 *   A full pre-start snapshot gives a clean rollback point from immediately
 *   before each startup, regardless of what herdsman does during that session.
 *
 * Storage layout (all under config.data_dir):
 *   snapshots/
 *     2026-04-04_09-58-42/
 *       coordinator_backup.json
 *       database.db
 *     2026-04-03_21-10-05/
 *       coordinator_backup.json
 *       database.db
 *     ...
 *
 * Rolling retention: oldest snapshots beyond `keep` count are pruned.
 * Only files that exist at snapshot time are copied (first-run may have neither).
 * Failures are non-fatal — always logs a warning and returns without throwing.
 */

const fs   = require('fs');
const path = require('path');

/** Files to include in each snapshot (relative to data_dir) */
const SNAPSHOT_FILES = [
  'coordinator_backup.json',
  'database.db',
];

/**
 * Take a pre-start snapshot of the coordinator backup and device database.
 *
 * @param {object} config   - loaded config (needs data_dir, startup_snapshot_keep)
 * @param {object} log      - logger instance
 * @returns {string|null}   - path of the new snapshot directory, or null on skip/error
 */
function takeSnapshot(config, log) {
  const dataDir   = config.data_dir ?? '/data';
  const keep      = config.startup_snapshot_keep ?? 10;
  const snapDir   = path.join(dataDir, 'snapshots');

  if (keep <= 0) {
    log.debug('[snapshot] startup_snapshot_keep=0 — pre-start snapshots disabled');
    return null;
  }

  // Determine which files actually exist right now
  const filesToCopy = SNAPSHOT_FILES.filter(f => fs.existsSync(path.join(dataDir, f)));
  if (filesToCopy.length === 0) {
    log.debug('[snapshot] No data files found — skipping pre-start snapshot');
    return null;
  }

  // Build timestamped directory name: YYYY-MM-DD_HH-mm-ss
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts  = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
              `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const dest = path.join(snapDir, ts);

  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const file of filesToCopy) {
      fs.copyFileSync(path.join(dataDir, file), path.join(dest, file));
    }
    log.info(`[snapshot] Pre-start snapshot saved to snapshots/${ts} (${filesToCopy.join(', ')})`);
  } catch (err) {
    log.warn(`[snapshot] Failed to create pre-start snapshot: ${err.message}`);
    return null;
  }

  // Prune snapshots beyond the keep count (sort ascending by name — ISO timestamps sort lexically)
  try {
    const all = fs.readdirSync(snapDir)
      .filter(entry => {
        try { return fs.statSync(path.join(snapDir, entry)).isDirectory(); } catch { return false; }
      })
      .sort(); // oldest first

    const excess = all.length - keep;
    if (excess > 0) {
      const toDelete = all.slice(0, excess);
      for (const old of toDelete) {
        const oldPath = path.join(snapDir, old);
        try {
          for (const f of fs.readdirSync(oldPath)) fs.unlinkSync(path.join(oldPath, f));
          fs.rmdirSync(oldPath);
        } catch (e) {
          log.debug(`[snapshot] Could not prune old snapshot ${old}: ${e.message}`);
        }
      }
      log.debug(`[snapshot] Pruned ${excess} old snapshot(s) (keeping ${keep})`);
    }
  } catch (err) {
    log.debug(`[snapshot] Prune pass failed: ${err.message}`);
  }

  return dest;
}

module.exports = { takeSnapshot };
