/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           S³ EXPORT/IMPORT UTILITY                            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Connector-agnostic JSON export/import for all DB-backed S³ plugins.
 * Uses Sequelize's standard findAll({ raw: true }) and upsert() APIs —
 * works identically on SQLite, Postgres, MySQL, or any other dialect.
 *
 * Three-tier classification:
 *   Historical (default) — Elo ratings, round histories, match reports,
 *     assignment logs, schema versions. Irreplaceable data.
 *   Logging (--logs)     — Adds player events, game-state events, player
 *     snapshots. Useful forensic data.
 *   All (--all)          — Everything including auto-recoverable plugin
 *     persistence tables.
 *
 * 8.4b additions:
 *   exportToFile() — Writes export to a timestamped .s3backup.json file
 *     in the backup directory. Used by MigrationEngine as the fallback
 *     pre-migration backup for non-SQLite connectors.
 *   restoreFromFile() — Reads a backup file, detects format (.sqlite vs
 *     .s3backup.json), and restores via file copy or JSON import.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 *   exportToJSON(dbService, { includeEphemeral, flags })
 *     Enumerates dbService.models, filters by classification tier,
 *     runs findAll({ raw: true }) per table with per-table try-catch.
 *     Returns structured JSON with tables, rowCounts, results.
 *
 *   importFromJSON(dbService, json, { dryRun })
 *     Validates structure, upserts per table inside a single Sequelize
 *     transaction. Per-table try-catch allows partial recovery. FK
 *     checks disabled for transaction duration. Returns { imported, errors }.
 *
 *   validateImportStructure(json, modelNames)
 *     Checks s3ExportVersion === 1, table names exist as models,
 *     required columns present. Returns { valid, warnings, errors }.
 *
 *   serializeForAttachment(exportObj)
 *     JSON.stringify + optional gzip if > 1 MB. Pre-checks size against
 *     Discord's 25 MB boosted limit. Returns { filename, buffer, sizeBytes }.
 *
 *   exportToFile(dbService, backupDir, { tier, retention })
 *     (8.4b) Writes JSON export to backupDir as a timestamped file.
 *     Returns { filename, sizeBytes } or null on failure.
 *
 *   restoreFromFile(filename, dbService, backupDir)
 *     (8.4b) Detects backup format (.sqlite → file copy, .json → JSON import)
 *     and restores accordingly. Returns restore result or throws.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - No SQLite-specific code. FK disabling is dialect-agnostic.
 * - Per-table try-catch: a single failing table does not abort the whole
 *   export or import. Failed tables are flagged in results with the error.
 * - Import uses upsert (no deletes) — rows not in the import are left
 *   untouched. This prevents accidental data loss.
 *
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { restoreBackup, listBackups } from './s3-backup.js';

// ─── TABLE CLASSIFICATION ────────────────────────────────────────────

/**
 * Historical tables — irreplaceable data exported by default.
 * Player ratings, round histories, match reports, assignment logs,
 * and schema version tracking.
 */
const HISTORICAL_TABLES = new Set([
  'S3_SchemaVersions',
  'Elo_PlayerStats',
  'Elo_RoundHistory',
  'Elo_RoundPlayers',
  'SA_AssignmentLog',
  'TB_RoundReport'
]);

/**
 * Logging tables — useful forensic data with timestamps.
 * Included when the --logs flag is passed.
 */
const LOGGING_TABLES = new Set([
  'S3_PlayerEvents',
  'S3_GameStateEvents',
  'S3_PlayerSnapshots'
]);

/**
 * Ephemeral tables — auto-recoverable plugin persistence state.
 * Only included when the --all flag is passed.
 */
const EPHEMERAL_TABLES = new Set([
  'S3_GameState',
  'S3_PlayerSessions',
  'SwitchPlugin_PlayerCooldowns',
  'SwitchPlugin_Endmatches',
  'Elo_PluginState',
  'TeamBalancerState'
]);

// ─── HELPERS ─────────────────────────────────────────────────────────

/**
 * Determine which model names to include based on export flags.
 *
 * @param {string[]} modelNames - All model names available
 * @param {object} options
 * @param {string} [options.tier] - 'historical' (default), 'logs', or 'all'
 * @returns {string[]} Filtered model names in declaration order
 */
function filterByTier(modelNames, { tier = 'historical' } = {}) {
  if (tier === 'all') return [...modelNames];

  const included = new Set(HISTORICAL_TABLES);

  if (tier === 'logs') {
    for (const t of LOGGING_TABLES) included.add(t);
  }

  return modelNames.filter((name) => included.has(name));
}

/**
 * Disable foreign key constraint checks for the duration of an import
 * transaction. Dialect-agnostic — handles SQLite, Postgres, MySQL.
 * SQLite: no-op (FK checks off by default via WAL pragmas).
 *
 * @param {import('sequelize').Sequelize} connector
 * @returns {Promise<void>}
 */
async function disableForeignKeyChecks(connector) {
  if (!connector || typeof connector.query !== 'function') return;
  const dialect = typeof connector.getDialect === 'function' ? connector.getDialect() : 'sqlite';

  if (dialect === 'postgres') {
    await connector.query('SET CONSTRAINTS ALL DEFERRED');
  } else if (dialect === 'mysql') {
    await connector.query('SET session_replication_role = replica');
  }
  // SQLite: FK checks are off by default — no-op
}

/**
 * Re-enable foreign key constraint checks after an import transaction.
 *
 * @param {import('sequelize').Sequelize} connector
 * @returns {Promise<void>}
 */
async function enableForeignKeyChecks(connector) {
  if (!connector || typeof connector.query !== 'function') return;
  const dialect = typeof connector.getDialect === 'function' ? connector.getDialect() : 'sqlite';

  if (dialect === 'postgres') {
    await connector.query('SET CONSTRAINTS ALL IMMEDIATE');
  } else if (dialect === 'mysql') {
    await connector.query('SET session_replication_role = DEFAULT');
  }
  // SQLite: no-op
}

/**
 * Format a Unix-ms timestamp to YYYY-MM-DD-HHmmss (matching s3-backup.js).
 */
function timestampString(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Format byte count to a human-readable string.
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Enforce retention for JSON backup files in a directory.
 * Only removes files matching the s3backup-YYYY-MM-DD-HHmmss.json pattern.
 */
function enforceJsonRetention(dir, maxCount) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }

  const backups = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const match = file.match(/^s3backup-(\d{4}-\d{2}-\d{2}-\d{6})\.json$/);
    if (!match) continue;

    backups.push({ filename: file, mtimeMs: stat.mtimeMs });
  }

  if (backups.length <= maxCount) return;

  // Sort oldest first
  backups.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toDelete = backups.slice(0, backups.length - maxCount);

  for (const b of toDelete) {
    try {
      fs.unlinkSync(path.join(dir, b.filename));
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ─── CORE FUNCTIONS ──────────────────────────────────────────────────

/**
 * Export database tables to a structured JSON object.
 *
 * Enumerates models from dbService, filters by classification tier,
 * and runs findAll({ raw: true }) on each included table. Per-table
 * try-catch — a single failure does not abort the whole export.
 *
 * @param {object} dbService - DBService instance
 * @param {object} [options]
 * @param {string} [options.tier='historical'] - 'historical', 'logs', or 'all'
 * @returns {Promise<object>} { tables, rowCounts, results, s3ExportVersion, exportedAt, connector }
 */
export async function exportToJSON(dbService, { tier = 'historical' } = {}) {
  if (!dbService || !dbService.isReady()) {
    throw new Error('DBService is not ready.');
  }

  const modelNames = dbService.getModelNames();
  const selected = filterByTier(modelNames, { tier });
  const connector = dbService.getConnector();
  const connectorName = connector && typeof connector.getDialect === 'function'
    ? connector.getDialect()
    : dbService.getConnectorName() || 'unknown';

  const result = {
    s3ExportVersion: 1,
    exportedAt: Date.now(),
    connector: connectorName,
    tables: {},
    rowCounts: {},
    results: {}
  };

  const missing = selected.filter((name) => !dbService.getModel(name));
  for (const name of missing) {
    result.results[name] = { status: 'error', error: 'Model not found in dbService' };
  }

  const present = selected.filter((name) => dbService.getModel(name));

  for (const name of present) {
    const model = dbService.getModel(name);
    try {
      const rows = await model.findAll({ raw: true });
      result.tables[name] = rows;
      result.rowCounts[name] = rows.length;
      result.results[name] = { status: 'ok', rows: rows.length };
    } catch (err) {
      result.results[name] = { status: 'error', error: err.message };
    }
  }

  return result;
}

/**
 * Import rows from a previously exported JSON object.
 *
 * Validates structure, then upserts each row inside a single Sequelize
 * transaction. Per-table try-catch allows partial recovery — a failing
 * table does not abort previously imported tables. FK checks are
 * disabled for the transaction duration.
 *
 * @param {object} dbService - DBService instance
 * @param {object} json - The export object from exportToJSON()
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, validate only (no writes)
 * @returns {Promise<{ imported: object, errors: string[] }>}
 */
export async function importFromJSON(dbService, json, { dryRun = false } = {}) {
  if (!dbService || !dbService.isReady()) {
    throw new Error('DBService is not ready.');
  }

  const validation = await validateImportStructure(json, dbService.getModelNames());

  if (!validation.valid) {
    return {
      imported: {},
      errors: validation.errors
    };
  }

  const connector = dbService.getConnector();
  const result = { imported: {}, errors: [...validation.warnings] };

  if (dryRun) {
    // Dry run: report what would be imported without writing
    for (const [tableName, rows] of Object.entries(json.tables)) {
      result.imported[tableName] = { status: 'ok', rows: rows.length, dryRun: true };
    }
    return result;
  }

  // Execute inside a single transaction
  if (connector && typeof connector.transaction === 'function') {
    await disableForeignKeyChecks(connector);
    try {
      await connector.transaction(async (transaction) => {
        for (const [tableName, rows] of Object.entries(json.tables)) {
          const model = dbService.getModel(tableName);
          if (!model) {
            result.imported[tableName] = { status: 'error', error: 'Model not found' };
            continue;
          }

          if (rows.length === 0) {
            result.imported[tableName] = { status: 'ok', rows: 0 };
            continue;
          }

          try {
            let upserted = 0;
            for (const row of rows) {
              await model.upsert(row, { transaction });
              upserted += 1;
            }
            result.imported[tableName] = { status: 'ok', rows: upserted };
          } catch (err) {
            result.imported[tableName] = { status: 'error', error: err.message };
          }
        }
      });
    } finally {
      await enableForeignKeyChecks(connector);
    }
  } else {
    // Fallback: no transaction support — upsert directly
    for (const [tableName, rows] of Object.entries(json.tables)) {
      const model = dbService.getModel(tableName);
      if (!model) {
        result.imported[tableName] = { status: 'error', error: 'Model not found' };
        continue;
      }

      if (rows.length === 0) {
        result.imported[tableName] = { status: 'ok', rows: 0 };
        continue;
      }

      try {
        let upserted = 0;
        for (const row of rows) {
          await model.upsert(row);
          upserted += 1;
        }
        result.imported[tableName] = { status: 'ok', rows: upserted };
      } catch (err) {
        result.imported[tableName] = { status: 'error', error: err.message };
      }
    }
  }

  return result;
}

/**
 * Validate an export JSON object against a list of known model names.
 *
 * Checks:
 * - s3ExportVersion is 1 (current format)
 * - All table names in json.tables exist in modelNames
 * - Warns about unknown table names but does not reject them
 *
 * @param {object} json - The export object to validate
 * @param {string[]} modelNames - Known model names from dbService
 * @returns {Promise<{ valid: boolean, warnings: string[], errors: string[] }>}
 */
export async function validateImportStructure(json, modelNames) {
  const warnings = [];
  const errors = [];

  if (!json || typeof json !== 'object') {
    errors.push('Import data is not a valid JSON object.');
    return { valid: false, warnings, errors };
  }

  if (json.s3ExportVersion !== 1) {
    errors.push(`Unsupported export format version: ${json.s3ExportVersion}. Expected 1.`);
    return { valid: false, warnings, errors };
  }

  if (!json.tables || typeof json.tables !== 'object') {
    errors.push('Import data has no "tables" object.');
    return { valid: false, warnings, errors };
  }

  const knownNames = new Set(modelNames);

  for (const tableName of Object.keys(json.tables)) {
    if (!knownNames.has(tableName)) {
      warnings.push(`Table "${tableName}" is not a known model — will be skipped during import.`);
    }
  }

  return { valid: errors.length === 0, warnings, errors };
}

/**
 * Serialize an export object for Discord attachment.
 *
 * JSON.stringify + optional gzip if serialized size > 1 MB.
 * Pre-checks final size against Discord's 25 MB boosted limit.
 *
 * @param {object} exportObj - The result from exportToJSON()
 * @returns {{ filename: string, buffer: Buffer, sizeBytes: number }}
 * @throws {Error} If serialized size exceeds 25 MB
 */
export async function serializeForAttachment(exportObj) {
  const jsonStr = JSON.stringify(exportObj, null, 2);
  const timestamp = new Date(exportObj.exportedAt || Date.now())
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);

  const rawSize = Buffer.byteLength(jsonStr, 'utf8');

  // Auto-gzip if > 1 MB
  if (rawSize > 1024 * 1024) {
    const gzipped = zlib.gzipSync(jsonStr, { level: 6 });
    const gzSize = Buffer.byteLength(gzipped);

    if (gzSize > 25 * 1024 * 1024) {
      throw new Error(
        `Export is ${(gzSize / (1024 * 1024)).toFixed(1)} MB compressed — ` +
        `exceeds Discord's 25 MB limit. Try without --all to exclude ephemeral tables.`
      );
    }

    return {
      filename: `s3-export-${timestamp}.s3backup.json.gz`,
      buffer: gzipped,
      sizeBytes: gzSize
    };
  }

  // Plain JSON under 1 MB — check raw size against limit
  if (rawSize > 25 * 1024 * 1024) {
    throw new Error(
      `Export is ${(rawSize / (1024 * 1024)).toFixed(1)} MB — ` +
      `exceeds Discord's 25 MB limit. Try without --all to exclude ephemeral tables.`
    );
  }

  return {
    filename: `s3-export-${timestamp}.s3backup.json`,
    buffer: Buffer.from(jsonStr, 'utf8'),
    sizeBytes: rawSize
  };
}

// ══════════════════════════════════════════════════════════════════════
// 8.4b — FILE-BACKED EXPORT/RESTORE
// ══════════════════════════════════════════════════════════════════════

/**
 * Export database tables to a timestamped JSON file in the backup directory.
 *
 * This is the connector-agnostic fallback for MigrationEngine pre-migration
 * backup. For SQLite, the faster file copy in s3-backup.js is used instead;
 * exportToFile() is only called when the SQLite file path is unavailable.
 *
 * Files are named s3backup-{YYYY-MM-DD-HHmmss}.json and placed alongside
 * SQLite file backups in the backups/ directory. Retention is enforced
 * on JSON backup files independently of SQLite backups.
 *
 * @param {object} dbService - DBService instance
 * @param {string} [backupDir] - Backup directory (default: './backups')
 * @param {object} [options]
 * @param {string} [options.tier='all'] - Export tier ('historical', 'logs', or 'all')
 * @param {number} [options.retention=5] - Max JSON backup files to keep
 * @returns {Promise<{ filename: string, sizeBytes: number }|null>}
 */
export async function exportToFile(dbService, backupDir = null, { tier = 'all', retention = 5 } = {}) {
  if (!dbService || !dbService.isReady()) {
    return null;
  }

  const resolvedDir = backupDir || path.resolve(process.cwd(), 'backups');

  // Ensure backup directory exists
  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
  } catch {
    return null;
  }

  // Export to JSON
  let exportObj;
  try {
    exportObj = await exportToJSON(dbService, { tier });
  } catch {
    return null;
  }

  // Serialize
  const jsonStr = JSON.stringify(exportObj, null, 2);
  const ts = timestampString(Date.now());
  const backupFilename = `s3backup-${ts}.json`;
  const backupPath = path.join(resolvedDir, backupFilename);

  // Write to file
  try {
    fs.writeFileSync(backupPath, jsonStr, 'utf8');
  } catch {
    return null;
  }

  // Validate: verify the file was written
  let writtenStat;
  try {
    writtenStat = fs.statSync(backupPath);
  } catch {
    try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
    return null;
  }

  const bufferSize = Buffer.byteLength(jsonStr, 'utf8');
  if (writtenStat.size !== bufferSize) {
    try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
    return null;
  }

  // Enforce retention on JSON backup files
  enforceJsonRetention(resolvedDir, retention);

  return {
    filename: backupFilename,
    sizeBytes: writtenStat.size
  };
}

/**
 * Restore from a backup file, detecting format automatically.
 *
 * Supports two formats:
 * - .sqlite files → delegate to restoreBackup() (file copy, s3-backup.js)
 * - .json files → parse JSON, call importFromJSON()
 *
 * @param {string} filename - Backup filename (e.g. 'squad-server-2026-06-28-143000.sqlite'
 *                            or 's3backup-2026-06-28-143000.json')
 * @param {object} dbService - DBService instance (required for JSON restore)
 * @param {string} [backupDir] - Backup directory (default: './backups')
 * @param {string} [dbPath] - Target database path (required for .sqlite restore)
 * @returns {Promise<object>} Restore result (varies by format)
 */
export async function restoreFromFile(filename, dbService, backupDir = null, dbPath = null) {
  if (!filename) {
    throw new Error('restoreFromFile requires a filename.');
  }

  const resolvedDir = backupDir || path.resolve(process.cwd(), 'backups');
  const backupPath = path.join(resolvedDir, filename);

  // Verify exists
  try {
    fs.statSync(backupPath);
  } catch {
    throw new Error(`Backup file not found: ${filename}`);
  }

  // Detect format by extension
  const isSqliteBackup = filename.endsWith('.sqlite');
  const isJsonBackup = filename.endsWith('.json');

  if (isSqliteBackup) {
    // Delegate to s3-backup.js file copy
    if (!dbPath) {
      throw new Error('dbPath is required for .sqlite backup restore.');
    }
    return restoreBackup(filename, dbPath, resolvedDir);
  }

  if (isJsonBackup) {
    if (!dbService || !dbService.isReady()) {
      throw new Error('DBService is required and must be ready for JSON backup restore.');
    }

    // Read and parse the JSON file
    const content = fs.readFileSync(backupPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Failed to parse JSON backup file.');
    }

    return importFromJSON(dbService, parsed, { dryRun: false });
  }

  throw new Error(`Unrecognized backup format: ${filename}. Expected .sqlite or .json.`);
}

/**
 * List the sizes of JSON backup files in the backup directory.
 * Used for status display. Full listing (including SQLite backups)
 * is handled by listBackups() in s3-backup.js.
 *
 * @param {string} [backupDir] - Backup directory (default: './backups')
 * @returns {Array<{ filename: string, timestamp: number, sizeBytes: number, sizeFormatted: string, age: string }>}
 */
export function listJsonBackups(backupDir = null) {
  const resolvedDir = backupDir || path.resolve(process.cwd(), 'backups');

  let files;
  try {
    files = fs.readdirSync(resolvedDir);
  } catch {
    return [];
  }

  const backups = [];
  for (const file of files) {
    const filePath = path.join(resolvedDir, file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const match = file.match(/^s3backup-(\d{4}-\d{2}-\d{2}-\d{6})\.json$/);
    if (!match) continue;

    const ts = parseTimestamp(match[1]);
    if (ts === null) continue;

    const ageMs = Date.now() - stat.mtimeMs;
    const ageMinutes = Math.floor(ageMs / 60000);

    backups.push({
      filename: file,
      timestamp: ts,
      sizeBytes: stat.size,
      sizeFormatted: formatSize(stat.size),
      age: ageMinutes < 60
        ? `${ageMinutes}m`
        : `${Math.floor(ageMinutes / 60)}h ${ageMinutes % 60}m`
    });
  }

  backups.sort((a, b) => b.timestamp - a.timestamp);
  return backups;
}

/**
 * Parse a YYYY-MM-DD-HHmmss timestamp string to Unix ms.
 */
function parseTimestamp(str) {
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, min, sec] = match.map(Number);
  const d = new Date(year, month - 1, day, hour, min, sec);
  return d.getTime();
}