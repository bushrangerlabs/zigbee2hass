#!/usr/bin/env node
/**
 * scripts/generate-device-images.js
 *
 * Downloads the blakadder/zigbee GitHub repo, parses every device markdown
 * file's YAML frontmatter, and produces a JSON lookup table:
 *
 *   { "<raw herdsman modelID>": "<image URL on zigbee.blakadder.com>" }
 *
 * The raw herdsman modelID is what zigbee-herdsman puts in device.modelID
 * immediately on join — available before ZHC interview completes.
 *
 * Output: custom_components/zigbee2hass/www/zigbee-device-images.json
 *
 * Usage:
 *   node scripts/generate-device-images.js
 *   node scripts/generate-device-images.js --dry-run   (print stats only)
 *
 * Requires: curl, unzip  (standard on Linux/macOS)
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DRY_RUN    = process.argv.includes('--dry-run');
const IMAGE_BASE = 'https://zigbee.blakadder.com/assets/images/devices';
const REPO_ZIP   = 'https://github.com/blakadder/zigbee/archive/refs/heads/master.zip';
const OUT_FILE   = path.resolve(__dirname, '../custom_components/zigbee2hass/www/zigbee-device-images.json');

// ── Helpers ────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  return spawnSync('sh', ['-c', cmd], { stdio: 'pipe', encoding: 'utf8', ...opts });
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns null if no frontmatter found.
 * Handles only the subset of YAML used in blakadder files.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};

  // Parse each line — handle simple key: value and key: [array, items]
  let i = 0;
  const lines = yaml.split('\n');

  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) { i++; continue; }

    const key = kv[1];
    let   val = kv[2].trim();

    if (!val) {
      // Possible YAML block sequence — collect indented lines
      const items = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s+-\s+/, '').trim().replace(/^['"]|['"]$/g, ''));
        i++;
      }
      result[key] = items;
      continue;
    }

    // Inline array:  ['a', 'b']  or  [a, b]
    if (val.startsWith('[')) {
      const inner = val.replace(/^\[|\]$/g, '').trim();
      result[key] = inner
        ? inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        : [];
    } else {
      result[key] = val.replace(/^['"]|['"]$/g, '');
    }

    i++;
  }

  return result;
}

/**
 * Derive the image URL for a device.
 * Uses the explicit `image:` field if present, otherwise constructs
 * {Vendor}_{Model}.webp from the filename slug.
 */
function imageUrl(slug, fm) {
  if (fm.image && fm.image.startsWith('/assets/')) {
    // e.g. /assets/images/devices/Ikea_E1525.jpg
    return `https://zigbee.blakadder.com${fm.image}`;
  }
  // Default: .webp
  return `${IMAGE_BASE}/${slug}.webp`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blakadder-'));
  const zipPath = path.join(tmpDir, 'repo.zip');

  // 1. Download repo ZIP
  console.log('Downloading blakadder/zigbee repository...');
  const dl = run(`curl -sL -o "${zipPath}" "${REPO_ZIP}"`);
  if (dl.status !== 0) {
    console.error('curl failed:', dl.stderr);
    process.exit(1);
  }
  console.log(`Downloaded to ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);

  // 2. Extract just the _zigbee/ directory
  console.log('Extracting _zigbee/ ...');
  const unzip = run(`unzip -q "${zipPath}" "zigbee-master/_zigbee/*" -d "${tmpDir}"`);
  if (unzip.status !== 0) {
    console.error('unzip failed:', unzip.stderr);
    process.exit(1);
  }

  const zigbeeDir = path.join(tmpDir, 'zigbee-master', '_zigbee');
  const files = fs.readdirSync(zigbeeDir).filter(f => f.endsWith('.md'));
  console.log(`Found ${files.length} device files`);

  // 3. Parse each file and build lookup
  const lookup = {}; // raw modelID → image URL
  let parsed = 0, skipped = 0, noModel = 0;

  for (const file of files) {
    const slug    = file.replace(/\.md$/, '');  // e.g. "Sonoff_SNZB-03"
    const content = fs.readFileSync(path.join(zigbeeDir, file), 'utf8');
    const fm      = parseFrontmatter(content);

    if (!fm) { skipped++; continue; }

    const zigbeemodels = Array.isArray(fm.zigbeemodel) ? fm.zigbeemodel : [];
    if (zigbeemodels.length === 0) { noModel++; continue; }

    const url = imageUrl(slug, fm);

    for (const rawModel of zigbeemodels) {
      if (!rawModel) continue;
      // Don't overwrite existing entries (first match wins — files sorted alpha)
      if (!lookup[rawModel]) {
        lookup[rawModel] = url;
      }
    }

    parsed++;
  }

  console.log(`\nResults:`);
  console.log(`  Parsed:    ${parsed}`);
  console.log(`  No model:  ${noModel}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Entries:   ${Object.keys(lookup).length} modelID → image mappings`);

  // Sample output
  const sample = Object.entries(lookup).slice(0, 5);
  console.log(`\nSample entries:`);
  for (const [k, v] of sample) {
    console.log(`  ${JSON.stringify(k)} → ${v}`);
  }

  // 4. Write output
  if (!DRY_RUN) {
    const json = JSON.stringify(lookup, null, 2);
    fs.writeFileSync(OUT_FILE, json, 'utf8');
    console.log(`\nWrote ${Object.keys(lookup).length} entries to:`);
    console.log(`  ${OUT_FILE}`);
    console.log(`  (${(Buffer.byteLength(json) / 1024).toFixed(1)} KB)`);
  } else {
    console.log('\nDry run — no file written.');
  }

  // 5. Cleanup
  run(`rm -rf "${tmpDir}"`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
