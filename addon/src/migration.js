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

      // Validate it is a herdsman-format backup.
      // Old format: { coordinatorIeeeAddress, data, ... }
      // New open-coordinator-backup format: { coordinator_ieee, pan_id, metadata, ... }
      const isValid = backup.coordinatorIeeeAddress || backup.data ||
                      backup.coordinator_ieee || backup.pan_id ||
                      backup.metadata?.format?.includes('coordinator-backup');
      if (!isValid) {
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
   * Extract device friendly names from a Z2M data directory.
   * Checks devices.yaml first (newer Z2M), then the devices section of
   * configuration.yaml.  Uses js-yaml so all YAML quoting styles are handled.
   * @param {string} z2mDataDir
   * @returns {object} ieee_address → friendly_name map
   */
  extractDeviceNames(z2mDataDir) {
    const yaml  = require('js-yaml');
    const names = {}; // ieee → friendly_name

    // devices.yaml — present when Z2M splits devices into a separate file
    const devicesYamlPath = path.join(z2mDataDir, 'devices.yaml');
    if (fs.existsSync(devicesYamlPath)) {
      try {
        const parsed = yaml.load(fs.readFileSync(devicesYamlPath, 'utf8')) ?? {};
        for (const [ieee, cfg] of Object.entries(parsed)) {
          if (cfg?.friendly_name) names[ieee] = cfg.friendly_name;
        }
        this.log.info(`[migration] Loaded ${Object.keys(names).length} device name(s) from devices.yaml`);
      } catch (err) {
        this.log.warn(`[migration] Could not parse devices.yaml: ${err.message}`);
      }
    }

    // configuration.yaml — standard single-file Z2M setup
    const configYamlPath = path.join(z2mDataDir, 'configuration.yaml');
    if (fs.existsSync(configYamlPath)) {
      try {
        const parsed = yaml.load(fs.readFileSync(configYamlPath, 'utf8')) ?? {};
        for (const [ieee, cfg] of Object.entries(parsed.devices ?? {})) {
          if (cfg?.friendly_name && !names[ieee]) {
            names[ieee] = cfg.friendly_name; // devices.yaml takes priority
          }
        }
        this.log.info(`[migration] After configuration.yaml: ${Object.keys(names).length} total device name(s)`);
      } catch (err) {
        this.log.warn(`[migration] Could not parse configuration.yaml: ${err.message}`);
      }
    }

    return names;
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

    if (!fs.existsSync(z2mDataDir)) {
      throw new Error(`Z2M data directory not found: ${z2mDataDir}`);
    }

    const results = {
      coordinator_backup: this.importCoordinatorBackup(
        path.join(z2mDataDir, 'coordinator_backup.json')
      ),
      database: this.importDatabase(
        path.join(z2mDataDir, 'database.db')
      ),
      device_names: this.extractDeviceNames(z2mDataDir),
    };

    results.device_count = Object.keys(results.device_names).length;
    this.log.info(
      `[migration] Complete — backup=${results.coordinator_backup}, db=${results.database}, names=${results.device_count}`
    );
    return results;
  }

  /**
   * Apply files that were uploaded directly from the browser (remote Z2M host).
   * Each file arrives as a base64 string (binary) or raw text (YAML/JSON).
   *
   * @param {object} opts
   * @param {string|null} opts.backupB64   - base64-encoded coordinator_backup.json
   * @param {string|null} opts.databaseB64 - base64-encoded database.db (SQLite binary)
   * @param {string|null} opts.namesText   - raw text of configuration.yaml or devices.yaml
   * @returns {{ coordinator_backup: boolean, database: boolean, device_names: object, device_count: number }}
   */
  applyFiles({ backupB64 = null, databaseB64 = null, namesText = null } = {}) {
    const results = { coordinator_backup: false, database: false, device_names: {}, device_count: 0 };

    // coordinator_backup.json
    if (backupB64) {
      try {
        const buf    = Buffer.from(backupB64, 'base64');
        const backup = JSON.parse(buf.toString('utf8'));
        const isValid = backup.coordinatorIeeeAddress || backup.data ||
                        backup.coordinator_ieee || backup.pan_id ||
                        backup.metadata?.format?.includes('coordinator-backup');
        if (!isValid) {
          this.log.error('[migration] Uploaded backup does not look like a herdsman coordinator backup');
        } else {
          const dest = path.join(this.config.data_dir, 'coordinator_backup.json');
          fs.writeFileSync(dest, JSON.stringify(backup, null, 2), 'utf8');
          this.log.info(`[migration] coordinator_backup.json written to ${dest}`);
          results.coordinator_backup = true;
        }
      } catch (err) {
        this.log.error(`[migration] Failed to apply coordinator backup: ${err.message}`);
      }
    }

    // database.db (binary SQLite)
    if (databaseB64) {
      try {
        const buf  = Buffer.from(databaseB64, 'base64');
        const dest = path.join(this.config.data_dir, 'database.db');
        if (fs.existsSync(dest)) {
          fs.copyFileSync(dest, dest + '.pre_migration_backup');
          this.log.info('[migration] Existing database.db backed up');
        }
        fs.writeFileSync(dest, buf);
        this.log.info(`[migration] database.db written to ${dest} (${buf.length} bytes)`);
        results.database = true;
      } catch (err) {
        this.log.error(`[migration] Failed to apply database: ${err.message}`);
      }
    }

    // Friendly names from YAML text (configuration.yaml or devices.yaml)
    if (namesText) {
      results.device_names = this.extractNamesFromText(namesText);
    }

    results.device_count = Object.keys(results.device_names).length;
    this.log.info(
      `[migration] applyFiles complete — backup=${results.coordinator_backup}, db=${results.database}, names=${results.device_count}`
    );
    return results;
  }

  /**
   * Extract device friendly names from raw YAML text.
   * Handles both configuration.yaml (has a 'devices:' key) and
   * devices.yaml (top-level keys are IEEE addresses).
   *
   * @param {string} text - raw YAML file content
   * @returns {object} ieee_address → friendly_name
   */
  extractNamesFromText(text) {
    const yaml  = require('js-yaml');
    const names = {};
    try {
      const parsed = yaml.load(text) ?? {};
      // devices.yaml: top-level keys are IEEE addresses
      // configuration.yaml: top-level has a 'devices' key containing IEEE addresses
      const section = (typeof parsed === 'object' && parsed !== null && parsed.devices &&
                       typeof parsed.devices === 'object' && !Array.isArray(parsed.devices))
        ? parsed.devices
        : parsed;
      for (const [ieee, cfg] of Object.entries(section)) {
        if (cfg?.friendly_name && /^0x[0-9a-fA-F]{16}$/i.test(ieee)) {
          names[ieee] = cfg.friendly_name;
        }
      }
      this.log.info(`[migration] Extracted ${Object.keys(names).length} device name(s) from uploaded YAML`);
    } catch (err) {
      this.log.warn(`[migration] Could not parse uploaded YAML: ${err.message}`);
    }
    return names;
  }
}

module.exports = { Z2MMigration };
