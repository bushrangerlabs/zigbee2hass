'use strict';

/**
 * Zigbee2MQTT migration importer.
 *
 * Reads a Zigbee2MQTT coordinator_backup.json and/or devices database
 * and prepares the data for import into zigbee2hass.
 *
 * The backup is a standard zigbee-herdsman backup format — both Z2M and
 * zigbee2hass use the same format since they share the same library.
 * Simply copying the backup file is sufficient for coordinator NVRam.
 *
 * Device friendly names and configuration are imported separately.
 */

const fs   = require('fs');
const path = require('path');
const { getLogger } = require('./logger');

class Z2MMigration {
  constructor(config) {
    this.config = config;
    this.log    = getLogger();
  }

  /**
   * Check if a Z2M backup exists at the expected path and copy it.
   * @param {string} z2mBackupPath  - path to Z2M coordinator_backup.json
   * @returns {boolean} true if imported
   */
  importCoordinatorBackup(z2mBackupPath) {
    if (!fs.existsSync(z2mBackupPath)) {
      this.log.warn(`[migration] Z2M backup not found at: ${z2mBackupPath}`);
      return false;
    }

    const destPath = path.join(this.config.data_dir, 'coordinator_backup.json');

    try {
      const backup = JSON.parse(fs.readFileSync(z2mBackupPath, 'utf8'));

      // Validate it is a herdsman-format backup
      if (!backup.coordinatorIeeeAddress && !backup.data) {
        this.log.error('[migration] File does not appear to be a valid coordinator backup');
        return false;
      }

      fs.writeFileSync(destPath, JSON.stringify(backup, null, 2), 'utf8');
      this.log.info(`[migration] Coordinator backup imported to ${destPath}`);
      return true;
    } catch (err) {
      this.log.error(`[migration] Failed to import coordinator backup: ${err.message}`);
      return false;
    }
  }

  /**
   * Import Z2M device database (database.db) — herdsman SQLite format.
   * Both Z2M and zigbee2hass use identical database schemas.
   * @param {string} z2mDatabasePath
   */
  importDatabase(z2mDatabasePath) {
    if (!fs.existsSync(z2mDatabasePath)) {
      this.log.warn(`[migration] Z2M database not found at: ${z2mDatabasePath}`);
      return false;
    }

    const destPath = path.join(this.config.data_dir, 'database.db');

    // If destination already has data, back it up first
    if (fs.existsSync(destPath)) {
      const backupDest = destPath + '.pre_migration_backup';
      fs.copyFileSync(destPath, backupDest);
      this.log.info(`[migration] Existing database backed up to ${backupDest}`);
    }

    fs.copyFileSync(z2mDatabasePath, destPath);
    this.log.info(`[migration] Z2M database imported to ${destPath}`);
    return true;
  }

  /**
   * Import Z2M configuration.yaml device friendly names and groups.
   * Returns a JSON object with device overrides that zigbee2hass can use.
   * @param {string} z2mConfigPath  - path to Z2M configuration.yaml
   */
  importDeviceNames(z2mConfigPath) {
    if (!fs.existsSync(z2mConfigPath)) {
      this.log.warn(`[migration] Z2M config not found at: ${z2mConfigPath}`);
      return null;
    }

    try {
      // Simple YAML parse for the devices section (avoid heavy yaml dep)
      const raw = fs.readFileSync(z2mConfigPath, 'utf8');
      const deviceNames = this._extractDeviceNames(raw);
      const groupNames  = this._extractGroupNames(raw);

      const result = { devices: deviceNames, groups: groupNames };
      const destPath = path.join(this.config.data_dir, 'migrated_names.json');
      fs.writeFileSync(destPath, JSON.stringify(result, null, 2), 'utf8');

      this.log.info(`[migration] Imported ${Object.keys(deviceNames).length} device names, ${Object.keys(groupNames).length} groups`);
      return result;
    } catch (err) {
      this.log.error(`[migration] Failed to import device names: ${err.message}`);
      return null;
    }
  }

  /**
   * Run full migration from a Z2M data directory.
   * Standard Z2M data locations:
   *   HA add-on:   /share/zigbee2mqtt/
   *   Manual:      ~/.mosquitto/  or wherever configured
   * @param {string} z2mDataDir
   */
  async runFullMigration(z2mDataDir) {
    this.log.info(`[migration] Starting full Z2M migration from: ${z2mDataDir}`);
    const results = {
      coordinator_backup: false,
      database:           false,
      device_names:       null,
    };

    results.coordinator_backup = this.importCoordinatorBackup(
      path.join(z2mDataDir, 'coordinator_backup.json')
    );

    results.database = this.importDatabase(
      path.join(z2mDataDir, 'database.db')
    );

    results.device_names = this.importDeviceNames(
      path.join(z2mDataDir, 'configuration.yaml')
    );

    this.log.info('[migration] Migration complete', results);
    return results;
  }

  // ── Private YAML helpers ─────────────────────────────────────────────────

  _extractDeviceNames(yamlText) {
    const result = {};
    const devicesMatch = yamlText.match(/^devices:\s*\n((?:[ \t]+.*\n?)*)/m);
    if (!devicesMatch) return result;

    const block = devicesMatch[1];
    const entries = block.match(/[ \t]+'?0x[0-9a-fA-F]{16}'?:\s*\n((?:[ \t]{4,}.*\n?)*)/g) || [];

    for (const entry of entries) {
      const ieeeMatch = entry.match(/'?(0x[0-9a-fA-F]{16})'?/);
      const nameMatch = entry.match(/friendly_name:\s*['"]?([^'">\n]+)['"]?/);
      if (ieeeMatch && nameMatch) {
        result[ieeeMatch[1]] = { friendly_name: nameMatch[1].trim() };
      }
    }
    return result;
  }

  _extractGroupNames(yamlText) {
    const result = {};
    const groupsMatch = yamlText.match(/^groups:\s*\n((?:[ \t]+.*\n?)*)/m);
    if (!groupsMatch) return result;

    const block = groupsMatch[1];
    const entries = block.match(/[ \t]+\d+:\s*\n((?:[ \t]{4,}.*\n?)*)/g) || [];

    for (const entry of entries) {
      const idMatch   = entry.match(/(\d+):/);
      const nameMatch = entry.match(/friendly_name:\s*['"]?([^'">\n]+)['"]?/);
      if (idMatch && nameMatch) {
        result[idMatch[1]] = { friendly_name: nameMatch[1].trim() };
      }
    }
    return result;
  }
}

module.exports = { Z2MMigration };
