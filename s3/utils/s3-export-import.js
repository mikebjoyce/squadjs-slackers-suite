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
 * Each model declares its own tier where it is defined:
 *
 *     defineModel('Elo_PlayerStats', schema, { exportTier: 'historical' })
 *
 * This file does not own the classification and no plugin needs to edit it to
 * have its tables backed up. `filterByTier()` reads the declarations back out
 * of DBService. An undeclared model is exported at the default tier and warned
 * about — see DEFAULT_EXPORT_TIER in db-service.js for why the fallback errs
 * towards including too much.
 *
 * Additions:
 *   exportToFile() — Streams the export to a timestamped .s3backup.json file
 *     in the backup directory. Used by MigrationEngine as the pre-migration
 *     backup, and by `!s3 db export`.
 *   restoreFromFile() — Reads a backup file, detects format (.sqlite vs
 *     .json), and restores via file copy or JSON import.
 *
 * ─── MEMORY ──────────────────────────────────────────────────────
 *
 * The file-backed half of this module streams; the object-returning half does
 * not. exportToFile() / importFromStreamFile() hold one batch of rows at a
 * time and are safe on a database of any size. exportToJSON() /
 * importFromJSON() / serializeForAttachment() materialise everything and are
 * only for datasets known to be small — a production db-log dataset is ~900MB,
 * and materialising it OOM-killed the SquadJS process during pre-migration
 * backup.
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
 *   exportToFile(dbService, backupDir, { tier, retention, models, batchSize })
 *     Streams a JSON export to backupDir as a timestamped file, one row batch
 *     at a time. Bounded memory on any database size.
 *     Returns { filename, path, sizeBytes, rowCounts, results, ... } or null.
 *
 *   gzipFileForAttachment(filePath, { limitBytes })
 *     Compresses an export file via a streaming pipeline and returns it as a
 *     Discord attachment buffer, or { attachable: false } with a reason.
 *
 *   importFromStreamFile(dbService, backupPath, { dryRun, chunkSize })
 *     Restores a file written by exportToFile() line by line, upserting in
 *     bounded per-transaction chunks. Never parses the whole document.
 *
 *   restoreFromFile(filename, dbService, backupDir)
 *     Detects backup format (.sqlite → file copy, .json → streamed or
 *     in-memory JSON import) and restores accordingly. Returns result or throws.
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
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import SequelizeLib from 'sequelize';
import { restoreBackup, listBackups } from './s3-backup.js';
import { formatSize, timestampString, parseTimestamp } from './s3-common.js';
// The English catalogue, used only as the default for callers that never reach
// Discord (tests, the internal restore path). Anything whose strings land in an
// embed must pass plugin.localize instead, or the operator's configured
// language is silently ignored for these lines.
import { localize as localizeEn } from './s3-i18n.js';

// ─── TABLE CLASSIFICATION ────────────────────────────────────────────

/*
 * ⚠️ THESE SETS ARE NO LONGER THE ALLOWLIST. They are the test fixture.
 *
 * Classification now lives at each model's definition site:
 *
 *     defineModel('SwitchPlugin_Settings', schema, { exportTier: 'historical' })
 *
 * filterByTier() reads dbService.getEffectiveModelTier(), so a third-party S³
 * consumer plugin can classify its own tables without editing this file. A
 * model that declares no tier is exported at the DEFAULT tier and warned about
 * when it is defined — over-exporting fails visibly (Discord's size limit),
 * under-exporting fails silently and permanently.
 *
 * The sets below are retained deliberately, as the expected classification that
 * `test-export-model-registration.js` asserts each in-repo model's *declared*
 * tier against. Moving a table between tiers therefore takes two deliberate
 * edits — the definition site and this fixture — rather than one word that
 * quietly changes what lands in every operator's backup. They were verified
 * against a real production export on 2026-08-19.
 *
 * ⚠️ They hold MODEL names, not table names. Several models deliberately pair a
 * non-underscored model name with an underscored table name (model
 * `S3GameStateEvents` → table `S3_GameStateEvents`), so a table name written
 * here matches no model at all.
 */

/**
 * Historical tables — irreplaceable data exported by default.
 * Player ratings, round histories, match reports, assignment logs,
 * operator-configured settings, and schema version tracking.
 */
const HISTORICAL_TABLES = new Set([
  'S3SchemaVersions',
  'Elo_PlayerStats',
  'Elo_RoundHistory',
  'Elo_RoundPlayers',
  'SA_AssignmentLog',
  'TB_RoundReport',
  // Operator-configured Switch settings. Not auto-recoverable — if lost, an
  // admin has to re-enter them by hand — so this belongs in the default tier
  // rather than with the ephemeral state. It was previously in no tier at all.
  'SwitchPlugin_Settings',
  // One row per round of switch activity. Nothing rebuilds it: once a round
  // is over its numbers exist nowhere else, and the Discord summaries they
  // used to be read back out of are not a recovery path for a translated
  // server.
  'SwitchPlugin_RoundStats'
]);

/**
 * Logging tables — useful forensic data with timestamps.
 * Included when the --logs flag is passed.
 */
const LOGGING_TABLES = new Set([
  'S3PlayerEvents',
  'S3GameStateEvents',
  'S3PlayerSnapshots'
]);

/**
 * Ephemeral tables — auto-recoverable plugin persistence state.
 * Only included when the --all flag is passed.
 */
const EPHEMERAL_TABLES = new Set([
  'S3GameState',
  'S3_PlayerSession',
  // Reconnect memory — rebuilt from live play, and entries expire on their own.
  // Previously in no tier at all.
  'S3PlayerReconnect',
  'SwitchPlugin_PlayerCooldowns',
  'SwitchPlugin_Endmatches',
  'Elo_PluginState',
  'TeamBalancerState'
]);

/**
 * The three tiers, exposed as the **expected classification fixture**. A test
 * asserts every in-repo model's declared `exportTier` equals its entry here,
 * and that these partition getModelNames() exhaustively. Nothing in the export
 * path reads them.
 */
export const TIER_SETS = Object.freeze({
  historical: HISTORICAL_TABLES,
  logging: LOGGING_TABLES,
  ephemeral: EPHEMERAL_TABLES
});

// ─── HELPERS ─────────────────────────────────────────────────────────

/**
 * Map the operator-facing export flag onto the set of model tiers it covers.
 *
 * The two vocabularies are deliberately distinct: `--logs` is a *cumulative*
 * CLI flag ("also give me the logs"), while `logging` is one exclusive tier a
 * model belongs to. Conflating them is how a model ends up in a flag nobody
 * expected.
 */
const TIERS_FOR_FLAG = Object.freeze({
  historical: ['historical'],
  logs: ['historical', 'logging'],
  all: ['historical', 'logging', 'ephemeral']
});

/**
 * Determine which model names to include based on export flags.
 *
 * Reads each model's declared tier from the dbService registry — see
 * `defineModel()`'s `exportTier` option. Models that declared no tier fall back
 * to DBService's DEFAULT_EXPORT_TIER, so a forgotten declaration over-exports
 * (visible, recoverable) rather than silently omitting the table.
 *
 * @param {object} dbService - DBService instance
 * @param {object} options
 * @param {string} [options.tier] - 'historical' (default), 'logs', or 'all'
 * @returns {string[]} Filtered model names in declaration order
 */
export function filterByTier(dbService, { tier = 'historical', models = null } = {}) {
  const modelNames = dbService.getModelNames();
  if (models && Array.isArray(models) && models.length > 0) {
    const modelSet = new Set(modelNames);
    return models.filter((name) => modelSet.has(name));
  }

  // `--all` still short-circuits, but now it is a superset of the tier logic
  // rather than a path that bypasses it: every model has an effective tier, and
  // all three are listed for this flag.
  if (tier === 'all') return [...modelNames];

  const includedTiers = TIERS_FOR_FLAG[tier] || TIERS_FOR_FLAG.historical;

  return modelNames.filter((name) => includedTiers.includes(dbService.getEffectiveModelTier(name)));
}

/**
 * Disable foreign key constraint checks for the duration of an import
 * transaction. Dialect-agnostic — handles SQLite, Postgres, MySQL.
 * SQLite: no-op (FK checks off by default via WAL pragmas).
 *
 * The two dialect branches used to be transposed: `SET session_replication_role`
 * is a *Postgres* setting and was being sent to MySQL, which rejects it with
 * "Unknown system variable 'session_replication_role'" and aborted the restore.
 * MySQL's equivalent is `SET FOREIGN_KEY_CHECKS`.
 *
 * On Postgres, `session_replication_role = replica` is the only statement that
 * genuinely suppresses FK triggers, but setting it requires superuser. When the
 * connection lacks that, fall back to `SET CONSTRAINTS ALL DEFERRED`, which any
 * role may issue — it only defers constraints declared DEFERRABLE, so it is a
 * partial measure, but it is strictly better than aborting the import.
 *
 * @param {import('sequelize').Sequelize} connector
 * @param {(level: number, msg: string) => void} [verboseLogger]
 * @returns {Promise<void>}
 */
async function disableForeignKeyChecks(connector, verboseLogger = () => {}) {
  if (!connector || typeof connector.query !== 'function') return;
  const dialect = typeof connector.getDialect === 'function' ? connector.getDialect() : 'sqlite';

  if (dialect === 'postgres') {
    try {
      await connector.query('SET session_replication_role = replica');
    } catch (err) {
      verboseLogger(2, `[ExportImport] session_replication_role unavailable (${err.message}) — falling back to SET CONSTRAINTS ALL DEFERRED. FK checks are only deferred for DEFERRABLE constraints.`);
      await connector.query('SET CONSTRAINTS ALL DEFERRED');
    }
  } else if (dialect === 'mysql') {
    await connector.query('SET FOREIGN_KEY_CHECKS = 0');
  }
  // SQLite: FK checks are off by default — no-op
}

/**
 * Re-enable foreign key constraint checks after an import transaction.
 * Mirrors disableForeignKeyChecks(), including the Postgres fallback.
 *
 * @param {import('sequelize').Sequelize} connector
 * @param {(level: number, msg: string) => void} [verboseLogger]
 * @returns {Promise<void>}
 */
async function enableForeignKeyChecks(connector, verboseLogger = () => {}) {
  if (!connector || typeof connector.query !== 'function') return;
  const dialect = typeof connector.getDialect === 'function' ? connector.getDialect() : 'sqlite';

  if (dialect === 'postgres') {
    try {
      await connector.query('SET session_replication_role = DEFAULT');
    } catch (err) {
      verboseLogger(2, `[ExportImport] Could not restore session_replication_role (${err.message}) — restoring constraints via SET CONSTRAINTS ALL IMMEDIATE.`);
      await connector.query('SET CONSTRAINTS ALL IMMEDIATE');
    }
  } else if (dialect === 'mysql') {
    await connector.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  // SQLite: no-op
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
export async function exportToJSON(dbService, { tier = 'historical', models = null } = {}) {
  if (!dbService || !dbService.isReady()) {
    throw new Error('DBService is not ready.');
  }

  const selected = filterByTier(dbService, { tier, models });
  const connector = dbService.getConnector();
  const connectorName = connector && typeof connector.getDialect === 'function'
    ? connector.getDialect()
    : dbService.getConnectorName() || 'unknown';

  // `tier` and `tiers` are additive, so this stays s3ExportVersion 1 and older
  // readers ignore them. They make a backup self-describing: a restore can tell
  // an operator "this file was taken at the default tier, so ephemeral state is
  // not in it" rather than leaving them to infer it from absence. Importers
  // must tolerate their absence — v1 files predating this change have neither.
  const result = {
    s3ExportVersion: 1,
    exportedAt: Date.now(),
    connector: connectorName,
    tier,
    tiers: Object.fromEntries(selected.map((name) => [name, dbService.getEffectiveModelTier(name)])),
    tables: {},
    rowCounts: {},
    results: {}
  };

  // Surface anything riding the default-tier fallback into the export result,
  // so an operator taking a backup sees it rather than only the author who
  // happened to be reading the mount log.
  const undeclared = typeof dbService.getUndeclaredModelNames === 'function'
    ? dbService.getUndeclaredModelNames().filter((name) => selected.includes(name))
    : [];
  if (undeclared.length > 0) {
    result.warnings = [
      `These models declare no exportTier and were exported at the default tier: ` +
      `${undeclared.join(', ')}. Declare one at each defineModel() call site.`
    ];
  }

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
 * @param {function} [options.localize] - Message lookup; pass plugin.localize
 *                                        when the result is rendered to Discord
 * @returns {Promise<{ imported: object, errors: string[] }>}
 */
export async function importFromJSON(dbService, json, { dryRun = false, localize = localizeEn } = {}) {
  if (!dbService || !dbService.isReady()) {
    throw new Error('DBService is not ready.');
  }

  const validation = await validateImportStructure(json, dbService.getModelNames(), localize);

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
    const fkLogger = typeof dbService.verboseLogger === 'function' ? dbService.verboseLogger : () => {};
    await disableForeignKeyChecks(connector, fkLogger);
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
      await enableForeignKeyChecks(connector, fkLogger);
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
 * @param {function} [localize] - Message lookup; pass plugin.localize when the
 *                                result is rendered to Discord
 * @returns {Promise<{ valid: boolean, warnings: string[], errors: string[] }>}
 */
export async function validateImportStructure(json, modelNames, localize = localizeEn) {
  const warnings = [];
  const errors = [];

  if (!json || typeof json !== 'object') {
    errors.push(localize('slackersSquadServices.db.importNotJsonObject'));
    return { valid: false, warnings, errors };
  }

  if (json.s3ExportVersion !== 1) {
    errors.push(localize('slackersSquadServices.db.importUnsupportedVersion', { version: json.s3ExportVersion }));
    return { valid: false, warnings, errors };
  }

  if (!json.tables || typeof json.tables !== 'object') {
    errors.push(localize('slackersSquadServices.db.importNoTablesObject'));
    return { valid: false, warnings, errors };
  }

  const knownNames = new Set(modelNames);

  for (const tableName of Object.keys(json.tables)) {
    if (!knownNames.has(tableName)) {
      warnings.push(localize('slackersSquadServices.db.importUnknownTableSkipped', { table: tableName }));
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
// FILE-BACKED EXPORT/RESTORE  (streaming)
// ══════════════════════════════════════════════════════════════════════

/*
 * Why this half of the file streams and the exportToJSON() half does not.
 *
 * exportToJSON() materialises every row of every selected table into one
 * object, and the old exportToFile() then ran JSON.stringify() over it. Both
 * steps scale with the size of the database, and neither has an upper bound:
 *
 *   - A production db-log dataset is ~900MB of rows. Holding that as JS objects
 *     costs several times its serialised size in heap.
 *   - JSON.stringify() then adds another full copy as a single string, on top of
 *     the objects it is reading.
 *
 * What actually killed the live server was the resident-set cost of that, not
 * any single hard limit: the container's memory ceiling was hit and the kernel
 * sent SIGKILL (exit 137) during the pre-migration backup, taking the whole
 * SquadJS instance down on mount. A big enough dataset would additionally run
 * into V8's max string length (~512MB on Node 18, ~1GB on Node 24), but the
 * process is normally OOM-killed well before it gets there.
 *
 * The streaming writer below never holds more than one batch of rows and one
 * ~256KB output buffer, regardless of table size, and honours write
 * backpressure so the gzip/file sink cannot be outrun. exportToJSON() is
 * retained for callers that genuinely want an in-memory object (imports,
 * validation, tests) on datasets known to be small.
 */

/**
 * Marker written into streamed exports. Its presence tells restoreFromFile()
 * that the file is laid out one row per line and can be imported without
 * parsing the whole document into memory. Files without it are legacy
 * pretty-printed exports and take the in-memory path.
 */
export const STREAM_FORMAT_VERSION = 1;

/** Discord's boosted per-attachment limit. */
const DISCORD_ATTACHMENT_LIMIT = 25 * 1024 * 1024;

/** Rows fetched per query while streaming. Bounds peak heap, not the output. */
const DEFAULT_BATCH_SIZE = 2000;

/** Bytes buffered before handing a chunk to the write stream. */
const WRITE_FLUSH_BYTES = 256 * 1024;

/**
 * Largest legacy (non-streamed) JSON backup we will attempt to read into
 * memory. Node 18's max string is ~512MB and JSON.parse peaks well above the
 * input size, so anything approaching that would OOM rather than error.
 */
const LEGACY_PARSE_LIMIT = 256 * 1024 * 1024;

/**
 * Resolve a write-stream 'drain' as a promise, without leaking the listener or
 * hanging if the stream errors while we are waiting. A plain
 * `once(stream, 'drain')` never settles when the sink is destroyed — which is
 * exactly how the first attempt at this fix hung instead of failing.
 *
 * @param {import('node:stream').Writable} stream
 * @returns {Promise<void>}
 */
function _onceDrain(stream) {
  return new Promise((resolve, reject) => {
    const onDrain = () => { stream.removeListener('error', onError); resolve(); };
    const onError = (err) => { stream.removeListener('drain', onDrain); reject(err); };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

/**
 * Small buffered writer over a Writable.
 *
 * Coalesces many small writes into ~256KB chunks (one fs write per row would
 * be needlessly chatty) and — the part that matters — awaits 'drain' whenever
 * the stream says its buffer is full. Ignoring `write()`'s return value is what
 * turns "streaming" back into "buffer the entire database in memory".
 */
class _BufferedWriter {
  constructor(stream) {
    this.stream = stream;
    this.parts = [];
    this.pending = 0;
  }

  async write(str) {
    this.parts.push(str);
    this.pending += str.length;
    if (this.pending >= WRITE_FLUSH_BYTES) await this.flush();
  }

  async flush() {
    if (this.parts.length === 0) return;
    const chunk = this.parts.join('');
    this.parts = [];
    this.pending = 0;
    if (!this.stream.write(chunk, 'utf8')) await _onceDrain(this.stream);
  }
}

/**
 * Yield a model's rows in batches without ever holding the whole table.
 *
 * Uses keyset pagination (`WHERE pk > :last ORDER BY pk LIMIT :n`) when the
 * model has a single-column primary key. `LIMIT ... OFFSET n` is O(n) per page
 * on MySQL — the server re-walks and discards every skipped row — so paging a
 * multi-million-row table with OFFSET is quadratic and takes longer than the
 * naive full load it was meant to replace. Keyset paging stays O(1) per page
 * because the index seeks straight to the cursor.
 *
 * Composite or absent primary keys fall back to OFFSET: correct, just slower.
 *
 * @param {object} model - Sequelize model
 * @param {number} batchSize
 * @yields {object[]} A batch of raw rows
 */
async function* _iterateRowBatches(model, batchSize) {
  const pkAttrs = Array.isArray(model.primaryKeyAttributes) ? model.primaryKeyAttributes : [];
  const Op = model.sequelize?.constructor?.Op || model.sequelize?.Sequelize?.Op || SequelizeLib.Op;
  const pk = pkAttrs.length === 1 && Op ? pkAttrs[0] : null;

  if (pk) {
    let last = null;
    for (;;) {
      const query = { raw: true, order: [[pk, 'ASC']], limit: batchSize };
      if (last !== null) query.where = { [pk]: { [Op.gt]: last } };
      const rows = await model.findAll(query);
      if (rows.length === 0) return;
      yield rows;
      last = rows[rows.length - 1][pk];
      if (rows.length < batchSize) return;
      // A null cursor cannot be advanced past — bail rather than loop forever.
      if (last === null || last === undefined) return;
    }
  } else {
    let offset = 0;
    for (;;) {
      const rows = await model.findAll({ raw: true, limit: batchSize, offset });
      if (rows.length === 0) return;
      yield rows;
      offset += rows.length;
      if (rows.length < batchSize) return;
    }
  }
}

/**
 * Export database tables to a timestamped JSON file in the backup directory,
 * streaming row batches straight to disk.
 *
 * This is the connector-agnostic pre-migration backup used by MigrationEngine,
 * and the backing store for `!s3 db export`. For SQLite, the faster file copy
 * in s3-backup.js runs alongside it.
 *
 * Files are named s3backup-{YYYY-MM-DD-HHmmss}.json and placed alongside
 * SQLite file backups in the backups/ directory. Retention is enforced on JSON
 * backup files independently of SQLite backups.
 *
 * The file is written to a `.partial` sibling and renamed on success, so a
 * crash mid-export cannot leave a truncated file that looks like a usable
 * backup (and `.partial` does not match the retention pattern, so it is never
 * mistaken for one).
 *
 * Output layout is ordinary JSON, with one row per line inside each table
 * array. That is what makes the file importable without parsing it whole —
 * see importFromStreamFile().
 *
 * @param {object} dbService - DBService instance
 * @param {string} [backupDir] - Backup directory (default: './backups')
 * @param {object} [options]
 * @param {string} [options.tier='all'] - Export tier ('historical', 'logs', or 'all')
 * @param {number} [options.retention=5] - Max JSON backup files to keep
 * @param {string[]|null} [options.models=null] - Explicit model allowlist
 * @param {number} [options.batchSize] - Rows per query
 * @param {(level:number,msg:string)=>void} [options.verboseLogger]
 * @returns {Promise<{ filename: string, path: string, sizeBytes: number, rowCounts: object, results: object, warnings: string[], connector: string, tier: string }|null>}
 */
export async function exportToFile(dbService, backupDir = null, {
  tier = 'all',
  retention = 5,
  models = null,
  batchSize = DEFAULT_BATCH_SIZE,
  verboseLogger = () => {}
} = {}) {
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

  let selected;
  try {
    selected = filterByTier(dbService, { tier, models });
  } catch (err) {
    verboseLogger(1, `[ExportImport] Export aborted — could not resolve models: ${err.message}`);
    return null;
  }

  const connector = dbService.getConnector();
  const connectorName = connector && typeof connector.getDialect === 'function'
    ? connector.getDialect()
    : dbService.getConnectorName() || 'unknown';

  const rowCounts = {};
  const results = {};
  const warnings = [];

  const undeclared = typeof dbService.getUndeclaredModelNames === 'function'
    ? dbService.getUndeclaredModelNames().filter((name) => selected.includes(name))
    : [];
  if (undeclared.length > 0) {
    warnings.push(
      `These models declare no exportTier and were exported at the default tier: ` +
      `${undeclared.join(', ')}. Declare one at each defineModel() call site.`
    );
  }

  for (const name of selected.filter((n) => !dbService.getModel(n))) {
    results[name] = { status: 'error', error: 'Model not found in dbService' };
  }
  const present = selected.filter((name) => dbService.getModel(name));

  const backupFilename = `s3backup-${timestampString(Date.now())}.json`;
  const backupPath = path.join(resolvedDir, backupFilename);
  const partialPath = `${backupPath}.partial`;

  const ws = fs.createWriteStream(partialPath, { encoding: 'utf8' });
  const w = new _BufferedWriter(ws);

  try {
    await w.write('{\n');
    await w.write('  "s3ExportVersion": 1,\n');
    await w.write(`  "s3StreamFormat": ${STREAM_FORMAT_VERSION},\n`);
    await w.write(`  "exportedAt": ${Date.now()},\n`);
    await w.write(`  "connector": ${JSON.stringify(connectorName)},\n`);
    await w.write(`  "tier": ${JSON.stringify(tier)},\n`);
    await w.write(`  "tiers": ${JSON.stringify(Object.fromEntries(selected.map((n) => [n, dbService.getEffectiveModelTier(n)])))},\n`);
    if (warnings.length > 0) await w.write(`  "warnings": ${JSON.stringify(warnings)},\n`);
    await w.write('  "tables": {\n');

    let firstTable = true;
    for (const name of present) {
      if (!firstTable) await w.write(',\n');
      firstTable = false;
      await w.write(`    ${JSON.stringify(name)}: [\n`);

      const model = dbService.getModel(name);
      let count = 0;
      try {
        for await (const batch of _iterateRowBatches(model, batchSize)) {
          let chunk = '';
          for (const row of batch) {
            chunk += (count === 0 ? '' : ',\n') + JSON.stringify(row);
            count += 1;
          }
          await w.write(chunk);
        }
        results[name] = { status: 'ok', rows: count };
      } catch (err) {
        // Per-table isolation, as before: one unreadable table does not abort
        // the export. Rows already streamed stay in the file and stay valid.
        results[name] = { status: 'error', error: err.message, rows: count };
      }
      rowCounts[name] = count;
      await w.write('\n    ]');
    }

    await w.write('\n  },\n');
    await w.write(`  "rowCounts": ${JSON.stringify(rowCounts)},\n`);
    await w.write(`  "results": ${JSON.stringify(results)}\n`);
    await w.write('}\n');
    await w.flush();

    await new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.end(resolve);
    });
  } catch (err) {
    try { ws.destroy(); } catch { /* ignore */ }
    try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
    verboseLogger(1, `[ExportImport] Streaming export failed: ${err.message}`);
    return null;
  }

  try {
    fs.renameSync(partialPath, backupPath);
  } catch (err) {
    try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
    verboseLogger(1, `[ExportImport] Could not finalise export file: ${err.message}`);
    return null;
  }

  let writtenStat;
  try {
    writtenStat = fs.statSync(backupPath);
  } catch {
    return null;
  }

  enforceJsonRetention(resolvedDir, retention);

  return {
    filename: backupFilename,
    path: backupPath,
    sizeBytes: writtenStat.size,
    rowCounts,
    results,
    warnings,
    connector: connectorName,
    tier
  };
}

/**
 * Compress an already-written export file and return it as a Discord
 * attachment, if it fits.
 *
 * Compression runs as a file→gzip→file pipeline, so a 900MB export costs a
 * fixed handful of stream buffers rather than its own size in heap. Only once
 * the compressed result is known to be under the limit is it read into a
 * Buffer — the size check happens before the allocation, not after it. The
 * temporary .gz is removed either way; nothing is left behind in backups/.
 *
 * @param {string} filePath - Path to a JSON export written by exportToFile()
 * @param {object} [options]
 * @param {number} [options.limitBytes] - Attachment ceiling (default 25MB)
 * @returns {Promise<{ attachable: boolean, filename?: string, buffer?: Buffer, sizeBytes: number, reason?: string }>}
 */
export async function gzipFileForAttachment(filePath, { limitBytes = DISCORD_ATTACHMENT_LIMIT } = {}) {
  const gzPath = `${filePath}.gz`;

  try {
    await pipeline(
      fs.createReadStream(filePath),
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(gzPath)
    );
  } catch (err) {
    try { fs.unlinkSync(gzPath); } catch { /* ignore */ }
    return { attachable: false, sizeBytes: 0, reason: `compression failed: ${err.message}` };
  }

  let stat;
  try {
    stat = fs.statSync(gzPath);
  } catch {
    return { attachable: false, sizeBytes: 0, reason: 'compressed file could not be read back' };
  }

  if (stat.size > limitBytes) {
    try { fs.unlinkSync(gzPath); } catch { /* ignore */ }
    return {
      attachable: false,
      sizeBytes: stat.size,
      reason: `compressed export is ${formatSize(stat.size)}, over Discord's ${formatSize(limitBytes)} attachment limit`
    };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(gzPath);
  } catch (err) {
    try { fs.unlinkSync(gzPath); } catch { /* ignore */ }
    return { attachable: false, sizeBytes: stat.size, reason: `could not read compressed file: ${err.message}` };
  }
  try { fs.unlinkSync(gzPath); } catch { /* ignore */ }

  return {
    attachable: true,
    filename: `${path.basename(filePath)}.gz`,
    buffer,
    sizeBytes: stat.size
  };
}

/**
 * Detect whether a JSON backup was written by the streaming exporter.
 *
 * Reads only the first 8KB — `s3StreamFormat` is the second key written, so it
 * is always well inside that window, and a 900MB file costs one small read.
 *
 * @param {string} backupPath
 * @returns {boolean}
 */
function _isStreamFormat(backupPath) {
  let fd;
  try {
    fd = fs.openSync(backupPath, 'r');
    const buf = Buffer.alloc(8192);
    const read = fs.readSync(fd, buf, 0, 8192, 0);
    return /"s3StreamFormat"\s*:\s*1/.test(buf.subarray(0, read).toString('utf8'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Import a streamed export file line by line, without parsing it whole.
 *
 * A backup that cannot be restored is not a backup. The in-memory importer
 * needs the entire document as a JS object, so a 900MB export written by
 * exportToFile() would be unrestorable on the very server that produced it —
 * `fs.readFileSync(..., 'utf8')` alone exceeds V8's max string on Node 18.
 *
 * This reads the file as lines instead. It works because exportToFile() writes
 * exactly one row per line and JSON.stringify escapes newlines inside strings,
 * so "one line" and "one row" cannot drift apart. Only the fixed structural
 * lines are pattern-matched; every row is parsed by JSON.parse as normal.
 *
 * Rows are upserted in bounded chunks, each in its own transaction, rather than
 * one transaction spanning millions of rows. A chunk that fails is reported
 * against its table and the rest of the import continues — matching
 * importFromJSON()'s per-table isolation.
 *
 * @param {object} dbService - DBService instance
 * @param {string} backupPath - Path to a file written by exportToFile()
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - Count rows without writing
 * @param {number} [options.chunkSize=500] - Rows per transaction
 * @param {(level:number,msg:string)=>void} [options.verboseLogger]
 * @param {function} [options.localize] - Message lookup; pass plugin.localize
 *                                        when the result is rendered to Discord
 * @returns {Promise<{ imported: object, errors: string[] }>}
 */
export async function importFromStreamFile(dbService, backupPath, {
  dryRun = false,
  chunkSize = 500,
  verboseLogger = () => {},
  localize = localizeEn
} = {}) {
  if (!dbService || !dbService.isReady()) {
    throw new Error('DBService is not ready.');
  }

  const known = new Set(dbService.getModelNames());
  const result = { imported: {}, errors: [] };
  const connector = dbService.getConnector();
  const fkLogger = typeof dbService.verboseLogger === 'function' ? dbService.verboseLogger : () => {};

  const upsertChunk = async (model, rows) => {
    if (dryRun || rows.length === 0) return;
    if (connector && typeof connector.transaction === 'function') {
      // No CLS in this codebase — the transaction handle has to be passed
      // explicitly to every call inside it.
      await connector.transaction(async (transaction) => {
        for (const row of rows) await model.upsert(row, { transaction });
      });
    } else {
      for (const row of rows) await model.upsert(row);
    }
  };

  const input = fs.createReadStream(backupPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let inTables = false;
  /** @type {{name:string, model:object|null, buffer:object[], count:number, failed:boolean}|null} */
  let current = null;

  const finishTable = async () => {
    if (!current) return;
    if (current.model && !current.failed) {
      try {
        await upsertChunk(current.model, current.buffer);
        result.imported[current.name] = { status: 'ok', rows: current.count, ...(dryRun ? { dryRun: true } : {}) };
      } catch (err) {
        result.imported[current.name] = { status: 'error', error: err.message, rows: current.count };
      }
    } else if (!current.model) {
      result.imported[current.name] = { status: 'error', error: 'Model not found' };
    }
    current = null;
  };

  if (!dryRun) await disableForeignKeyChecks(connector, fkLogger);
  try {
    for await (const rawLine of rl) {
      const line = rawLine.replace(/\r$/, '');

      if (!inTables) {
        if (line === '  "tables": {') inTables = true;
        continue;
      }

      if (current === null) {
        const opened = line.match(/^ {4}("(?:[^"\\]|\\.)*"): \[$/);
        if (opened) {
          const name = JSON.parse(opened[1]);
          const model = known.has(name) ? dbService.getModel(name) : null;
          if (!model) {
            result.errors.push(localize('slackersSquadServices.db.importUnknownTableSkippedStream', { table: name }));
          }
          current = { name, model, buffer: [], count: 0, failed: false };
          continue;
        }
        // `  },` closes the tables object; everything after it is trailer
        // metadata (rowCounts / results) that we do not need.
        if (line === '  },' || line === '  }') break;
        continue;
      }

      if (line === '    ]' || line === '    ],') {
        await finishTable();
        continue;
      }

      const trimmed = line.trim();
      if (trimmed === '') continue;
      const rowJson = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;

      if (current.failed || !current.model) continue;

      let row;
      try {
        row = JSON.parse(rowJson);
      } catch (err) {
        current.failed = true;
        result.imported[current.name] = { status: 'error', error: `malformed row at row ${current.count + 1}: ${err.message}`, rows: current.count };
        continue;
      }

      current.buffer.push(row);
      current.count += 1;
      if (current.buffer.length >= chunkSize) {
        const batch = current.buffer;
        current.buffer = [];
        try {
          await upsertChunk(current.model, batch);
        } catch (err) {
          current.failed = true;
          result.imported[current.name] = { status: 'error', error: err.message, rows: current.count };
        }
      }
    }
    await finishTable();
  } finally {
    rl.close();
    input.destroy();
    if (!dryRun) await enableForeignKeyChecks(connector, fkLogger);
  }

  verboseLogger(2, `[ExportImport] Streamed import of ${path.basename(backupPath)}: ${Object.keys(result.imported).length} table(s).`);
  return result;
}

/**
 * Restore from a backup file, detecting format automatically.
 *
 * Supports two formats:
 * - .sqlite files → delegate to restoreBackup() (file copy, s3-backup.js)
 * - .json files → streamed row-by-row if written by exportToFile(), otherwise
 *   parsed in memory and passed to importFromJSON()
 *
 * @param {string} filename - Backup filename (e.g. 'squad-server-2026-06-28-143000.sqlite'
 *                            or 's3backup-2026-06-28-143000.json')
 * @param {object} dbService - DBService instance (required for JSON restore)
 * @param {string} [backupDir] - Backup directory (default: './backups')
 * @param {string} [dbPath] - Target database path (required for .sqlite restore)
 * @param {function} [localize] - Message lookup; pass plugin.localize when the
 *                                result is rendered to Discord
 * @returns {Promise<object>} Restore result (varies by format)
 */
export async function restoreFromFile(filename, dbService, backupDir = null, dbPath = null, localize = localizeEn) {
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

    // Written by the streaming exporter — restore it the same way, one row at
    // a time. This is the only path that can restore a multi-hundred-MB backup.
    if (_isStreamFormat(backupPath)) {
      return importFromStreamFile(dbService, backupPath, { dryRun: false, localize });
    }

    // Legacy pretty-printed export: has to be parsed whole. Refuse rather than
    // OOM — reading it alone would exceed V8's max string length on Node 18.
    let legacyStat;
    try {
      legacyStat = fs.statSync(backupPath);
    } catch {
      throw new Error(`Backup file not found: ${filename}`);
    }
    if (legacyStat.size > LEGACY_PARSE_LIMIT) {
      throw new Error(
        `${filename} is ${formatSize(legacyStat.size)} and predates the streaming backup format, ` +
        `so it can only be restored by loading it entirely into memory — which would exhaust the ` +
        `Node heap. Restore it with an external tool, or take a fresh export first.`
      );
    }

    // Read and parse the JSON file
    const content = fs.readFileSync(backupPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Failed to parse JSON backup file.');
    }

    return importFromJSON(dbService, parsed, { dryRun: false, localize });
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

