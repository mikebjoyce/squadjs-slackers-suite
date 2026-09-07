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
 * ─── TWO AXES, NOT ONE ───────────────────────────────────────────
 *
 * Tier answers "how much of the data", and it is not the only
 * question once a community runs more than one server. Scope answers
 * "whose data", and the two are independent: any tier can be taken
 * for one server or for the whole community.
 *
 * Scope also comes from the model's own declaration rather than from
 * a list here. `scopePredicateFor()` turns a model's `scopeKind` into
 * a predicate, and `allServers: false` applies it to every
 * server-scoped table while leaving global tables alone — a
 * community-wide table is community-wide in every export, because
 * one row is the answer for everyone.
 *
 * The envelope records what was taken rather than leaving it to be
 * inferred from the filename: `scope` ('server' or 'community'),
 * the exporting `serverID`, and `containedServerIDs`, which is the
 * set actually present in the rows. A restore reads those instead of
 * trusting the operator's memory of which server a file came from.
 *
 * Import is where the two axes stop being symmetrical.
 * `makeImportPolicy()` treats `allServers` and `remapServer` as
 * different intentions rather than as degrees of one: adopting rows
 * that arrived without an id, taking a sibling's rows knowingly, and
 * rewriting rows onto this server are three separate decisions, and
 * collapsing them is how a restore quietly folds two servers into
 * one. `planImport()` renders all of it before anything is written.
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
 *   exportToJSON(dbService, { tier, models, allServers })
 *     Enumerates dbService.models, filters by classification tier,
 *     runs findAll({ raw: true }) per table with per-table try-catch.
 *     Returns structured JSON with tables, rowCounts, results.
 *     `allServers: false` narrows every server-scoped table to this
 *     process's server; global tables are community-wide either way.
 *
 *   importFromJSON(dbService, json, { dryRun, allServers, remapServer })
 *     Validates structure, upserts per table inside a single Sequelize
 *     transaction. Per-table try-catch allows partial recovery. FK
 *     checks disabled for transaction duration. Foreign rows are skipped
 *     unless asked for. Returns { imported, errors, plan }.
 *
 *   planImport(dbService, json, { allServers, remapServer })
 *     What an import WOULD do, per table, without writing: rows written,
 *     adopted, remapped, skipped, and overwritten — the last with the
 *     servers those existing rows currently belong to. What the
 *     confirmation is rendered from, and what the real import then runs.
 *
 *   validateImportStructure(json, modelNames)
 *     Checks s3ExportVersion === 1, table names exist as models,
 *     required columns present. Returns { valid, warnings, errors }.
 *
 *   serializeForAttachment(exportObj)
 *     JSON.stringify + optional gzip if > 1 MB. Pre-checks size against
 *     Discord's 25 MB boosted limit. Returns { filename, buffer, sizeBytes }.
 *
 *   exportToFile(dbService, backupDir, { tier, retention, models, batchSize, allServers })
 *     Streams a JSON export to backupDir as a timestamped file, one row batch
 *     at a time. Bounded memory on any database size. Defaults to the whole
 *     community, because its first caller is the pre-migration backup and a
 *     shared schema migrates for everyone at once.
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
 * - Import stamps the importing server’s id onto a server-scoped row that
 *   arrives without one, and never onto a row that has one. That is what lets
 *   a backup taken before this suite was multi-server restore onto a server
 *   that now is, without folding a second server’s rows into the first.
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
  // The server registry. Aliases and first-seen dates are operator-set or
  // one-shot: nothing in live play rewrites them, so a lost row loses which
  // server an admin's --server token used to name.
  'S3Servers',
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
  // Cross-process lock rows. Restoring these would resurrect locks held by
  // processes that no longer exist, so they are ephemeral in the strongest
  // sense: a fresh database is strictly better than a restored one.
  'S3Locks',
  'S3_PlayerSession',
  // Reconnect memory — rebuilt from live play, and entries expire on their own.
  // Previously in no tier at all.
  'S3PlayerReconnect',
  'SwitchPlugin_PlayerCooldowns',
  // The per-server half of the cooldown split: a scramble lock and a seed
  // clock, both of which describe a round that is over by the time anyone
  // restores a backup. Same tier as the wallet it was split out of, which is
  // what keeps an --all export self-consistent rather than restoring one
  // half of a player against a missing other half.
  'SwitchPlugin_PlayerServerState',
  'SwitchPlugin_Endmatches',
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

/**
 * Models a restore never writes, whatever tier they sit in.
 *
 * This is a **separate decision from the export tier**, and deliberately so.
 * `S3Locks` is `ephemeral`, which puts its rows inside an `--all` backup — that
 * is right for a backup, which is a snapshot of the database as it stood, and
 * an operator diffing two of them should be able to see which process held the
 * migration lock at the time.
 *
 * Restoring those rows is a different question with a different answer. A lock
 * row is a claim by a live process, and every process that held one at backup
 * time is gone by restore time. Reinstating one hands a claim to nobody:
 * `acquireLock()` steals a row only once its `expiresAt` has passed, so a
 * restored migration lock stalls every process's migration until the clock
 * catches up with a deadline that was set on a different day. The TTL bounds
 * that wait rather than removing it, and it bounds it at the wrong end — the
 * restore is exactly the moment migrations need to run.
 *
 * The alternative was to promote the TTL steal from a nicety to a correctness
 * requirement and lean on it here. That trade was refused: it would make a
 * restore's usability depend on a lock TTL chosen for live contention, and it
 * still leaves the stall. Skipping the write costs nothing, because a fresh
 * lock table is not merely acceptable after a restore — it is strictly better
 * than the restored one.
 *
 * Skipped tables are reported as `status: 'skipped'`, not as an error and not
 * as `ok` with zero rows: an operator reading the restore summary should see
 * that the table was passed over on purpose rather than that it happened to be
 * empty.
 */
export const IMPORT_SKIPPED_MODELS = Object.freeze(new Set(['S3Locks']));

/**
 * Build the function that gives an imported row a server to belong to.
 *
 * A `server-column` model’s rows are told apart by one column, and an
 * envelope can be missing it two ways. A backup taken before the column
 * existed has no such field at all; a backup taken from a table whose primary
 * key changed — the old table had no server in it, the new one keys on
 * (serverID, key) NOT NULL — has rows that cannot be written without one. In
 * both cases the rows came from the only server there was, and the server
 * doing the restore is it.
 *
 * Only where the value is absent. An envelope from a community already
 * running several servers carries real ids, and those say which server each
 * row belongs to. Overwriting them would fold every server’s rows onto
 * whichever one happened to run the restore, which is worse than the failure
 * this fixes because it succeeds quietly.
 *
 * Returns identity for a global or `server-key` model, for an undeclared one,
 * and for a declared column the model does not actually have — the
 * classification is declared ahead of the migrations that add the columns, so
 * a column named here is not yet a column that exists.
 *
 * The returned function returns the row unchanged when it stamps nothing, so
 * callers can count stamped rows by identity rather than re-checking.
 *
 * @param {object} dbService - DBService instance
 * @param {string} modelName - Registered model name (the envelope’s key)
 * @param {object} model - The Sequelize model for that name
 * @returns {(row: object) => object}
 */
function makeServerIDStamper(dbService, modelName, model) {
  let column = null;
  try {
    if (dbService.getModelScopeKind?.(modelName) === 'server-column') {
      const declared = dbService.getModelScopeColumn(modelName);
      const attributes = model?.rawAttributes || model?.getAttributes?.() || {};
      if (declared && attributes[declared]) column = declared;
    }
  } catch {
    // An import is not the place to fail over a classification lookup.
    column = null;
  }
  if (!column) return (row) => row;

  const serverID = dbService.getServerID();
  return (row) => (
    row[column] === undefined || row[column] === null
      ? { ...row, [column]: serverID }
      : row
  );
}

/**
 * What an import decides to do with one row.
 *
 * Five outcomes rather than write/skip, because an operator agreeing to an
 * import is agreeing to five different things and only one of them is
 * ordinary. `stamp` adopts a row that names no server; `remap` takes a row
 * that names a DIFFERENT server and claims it for this one; `foreign` writes
 * it back to the server it names, which on a single-server install leaves
 * rows no query will ever return.
 */
export const IMPORT_ROW_ACTIONS = Object.freeze({
  WRITE: 'write',
  STAMP: 'stamp',
  REMAP: 'remap',
  FOREIGN: 'foreign',
  SKIP: 'skip'
});

/**
 * Build the decision an import makes about every row of one table.
 *
 * The default is the narrow one: rows belonging to this server are written,
 * rows belonging to a sibling are skipped. Two flags widen it, and they are
 * different intentions rather than degrees of the same one — `allServers`
 * restores each row to the server it names, `remapServer` folds every row
 * onto this one. Passing both is a contradiction and the caller refuses it.
 *
 * A row carrying no server id is adopted rather than skipped, whatever the
 * flags say. That is the legacy-envelope rule, and it is the difference
 * between a pre-multi-server backup restoring and a pre-multi-server backup
 * reporting success per table having written nothing — and that backup is the
 * most likely thing anyone ever restores.
 *
 * Global models, and server-column models whose column has not landed yet,
 * have no per-row question to answer and write everything.
 *
 * Throws for a model whose scope was never declared, the same way
 * `scopePredicateFor()` does. The caller turns that into a per-table error;
 * an import that cannot tell whose rows these are must not write them.
 *
 * @param {object} dbService
 * @param {string} modelName
 * @param {object} model
 * @param {object} [options]
 * @param {boolean} [options.allServers=false]
 * @param {boolean} [options.remapServer=false]
 * @returns {{column: string|null, serverID: number, classify: (row: object) => {action: string, row: object, from?: number}}}
 */
function makeImportPolicy(dbService, modelName, model, { allServers = false, remapServer = false } = {}) {
  const serverID = dbService.getServerID();
  const scope = dbService.scopePredicateFor(modelName);

  if (!scope) {
    return { column: null, serverID, classify: (row) => ({ action: IMPORT_ROW_ACTIONS.WRITE, row }) };
  }

  const column = scope.column;
  return {
    column,
    serverID,
    classify(row) {
      const raw = row[column];
      if (raw === undefined || raw === null) {
        return { action: IMPORT_ROW_ACTIONS.STAMP, row: { ...row, [column]: serverID } };
      }

      const from = Number(raw);
      if (from === serverID) return { action: IMPORT_ROW_ACTIONS.WRITE, row };
      if (remapServer) return { action: IMPORT_ROW_ACTIONS.REMAP, row: { ...row, [column]: serverID }, from };
      if (allServers) return { action: IMPORT_ROW_ACTIONS.FOREIGN, row, from };
      return { action: IMPORT_ROW_ACTIONS.SKIP, row, from };
    }
  };
}

/** How many rows one existence probe asks about. */
const OVERWRITE_PROBE_CHUNK = 200;

/**
 * Which of the rows about to be written are already there, and whose they are.
 *
 * `model.upsert()` matches on the primary key, and for the nine tables keyed
 * on an autoincrement `id` that key says nothing about which server a row
 * belongs to. An envelope taken from a pre-multi-server database therefore
 * addresses `id`s that now belong to a sibling, and every one of those
 * upserts is a silent overwrite of somebody else's row.
 *
 * So this asks, before anything is written: of the keys in this envelope,
 * which exist, and which server does each of those rows currently say it
 * belongs to. The second half is the part worth reading — "142 rows will be
 * overwritten" is a number, and "142 rows currently belonging to `northern-2`
 * will be overwritten" is a decision.
 *
 * Asked in chunks rather than one row at a time, and skipped entirely for a
 * model with no primary key, where upsert cannot match an existing row.
 *
 * @param {object} model - Sequelize model
 * @param {string|null} scopeColumn - The model's server discriminator, if any
 * @param {object[]} rows - The rows as they will be WRITTEN, after any remap
 * @returns {Promise<{overwrite: number, servers: number[]}>}
 */
async function countExistingRows(model, scopeColumn, rows) {
  const pks = Array.isArray(model.primaryKeyAttributes) ? model.primaryKeyAttributes : [];
  if (pks.length === 0 || rows.length === 0) return { overwrite: 0, servers: [] };

  const Op = model.sequelize?.constructor?.Op || model.sequelize?.Sequelize?.Op || SequelizeLib.Op;
  if (!Op) return { overwrite: 0, servers: [] };

  // A row missing part of its key cannot be matched against an existing one —
  // an autoincrement id the envelope never carried, most often — so it is an
  // insert rather than an overwrite and is left out of the probe.
  const keyed = rows.filter((row) => pks.every((k) => row[k] !== undefined && row[k] !== null));
  if (keyed.length === 0) return { overwrite: 0, servers: [] };

  const attributes = [...new Set([...pks, ...(scopeColumn ? [scopeColumn] : [])])];
  const servers = new Set();
  let overwrite = 0;

  for (let i = 0; i < keyed.length; i += OVERWRITE_PROBE_CHUNK) {
    const chunk = keyed.slice(i, i + OVERWRITE_PROBE_CHUNK);
    const where = pks.length === 1
      ? { [pks[0]]: { [Op.in]: chunk.map((row) => row[pks[0]]) } }
      : { [Op.or]: chunk.map((row) => Object.fromEntries(pks.map((k) => [k, row[k]]))) };

    const existing = await model.findAll({ raw: true, attributes, where });
    overwrite += existing.length;
    if (scopeColumn) {
      for (const row of existing) noteServerID(servers, row[scopeColumn]);
    }
  }

  return { overwrite, servers: [...servers].sort((a, b) => a - b) };
}

/**
 * Work out what an import would do, per table, without writing anything.
 *
 * This is what the confirmation is rendered from, and it is deliberately the
 * same code path the real import then runs: a dry run that predicted the
 * import by different means would be a second implementation of the rules,
 * and the one that matters is the one that writes.
 *
 * `unknownTables` names envelope keys no model answers to. Those were
 * previously a warning inside a result that otherwise read as a success —
 * which is how a restore quietly omits a whole table. A model name changing
 * is one way to get here; a plugin not being mounted in this process is the
 * other, and on a shared database that one is ordinary.
 *
 * @param {object} dbService
 * @param {object} json - A parsed export envelope
 * @param {object} [options]
 * @param {boolean} [options.allServers=false]
 * @param {boolean} [options.remapServer=false]
 * @returns {Promise<object>} The plan
 */
export async function planImport(dbService, json, { allServers = false, remapServer = false } = {}) {
  const plan = {
    serverID: dbService.getServerID(),
    allServers,
    remapServer,
    tables: {},
    unknownTables: [],
    writtenServerIDs: [],
    overwrittenServerIDs: [],
    skippedServerIDs: [],
    totals: { total: 0, write: 0, stamp: 0, remap: 0, foreign: 0, skip: 0, overwrite: 0 }
  };

  const written = new Set();
  const overwritten = new Set();
  const skipped = new Set();

  for (const [name, rawRows] of Object.entries(json?.tables || {})) {
    const rows = Array.isArray(rawRows) ? rawRows : [];
    plan.totals.total += rows.length;

    if (IMPORT_SKIPPED_MODELS.has(name)) {
      plan.tables[name] = { status: 'skipped', total: rows.length };
      continue;
    }

    const model = dbService.getModel(name);
    if (!model) {
      plan.unknownTables.push({ name, rows: rows.length });
      plan.tables[name] = { status: 'unknown', total: rows.length };
      continue;
    }

    let policy;
    try {
      policy = makeImportPolicy(dbService, name, model, { allServers, remapServer });
    } catch (err) {
      plan.tables[name] = { status: 'error', total: rows.length, error: err.message };
      continue;
    }

    const entry = {
      status: 'ok',
      total: rows.length,
      write: 0, stamp: 0, remap: 0, foreign: 0, skip: 0,
      overwrite: 0,
      overwriteServerIDs: [],
      // Every foreign server this table mentions, whatever became of its
      // rows...
      sourceServerIDs: [],
      // ...and the subset whose rows were actually left behind. The two are
      // the same list until a widening flag is on, and the one a summary has
      // to name is this one — saying "rows belonging to X were skipped" when
      // they were in fact written is the wrong direction to be wrong in.
      skipServerIDs: []
    };

    const toWrite = [];
    const sources = new Set();
    const skippedHere = new Set();
    for (const row of rows) {
      const decision = policy.classify(row);
      entry[decision.action] += 1;
      if (decision.from !== undefined) noteServerID(sources, decision.from);
      if (decision.action === IMPORT_ROW_ACTIONS.SKIP) {
        noteServerID(skipped, decision.from);
        noteServerID(skippedHere, decision.from);
        continue;
      }
      toWrite.push(decision.row);
      if (policy.column) noteServerID(written, decision.row[policy.column]);
    }
    entry.sourceServerIDs = [...sources].sort((a, b) => a - b);
    entry.skipServerIDs = [...skippedHere].sort((a, b) => a - b);

    try {
      // Counted against the rows as they will be written, not as they arrived:
      // a remap changes the very column the match is made on for a server-key
      // model, so probing the envelope's own values would count the wrong rows.
      const existing = await countExistingRows(model, policy.column, toWrite);
      entry.overwrite = existing.overwrite;
      entry.overwriteServerIDs = existing.servers;
      for (const id of existing.servers) overwritten.add(id);
    } catch (err) {
      // A table that cannot be probed is still importable. Say the count is
      // unknown rather than reporting zero, which would read as "nothing of
      // yours is at risk".
      entry.overwrite = null;
      entry.overwriteError = err.message;
    }

    for (const key of ['write', 'stamp', 'remap', 'foreign', 'skip']) plan.totals[key] += entry[key];
    if (typeof entry.overwrite === 'number') plan.totals.overwrite += entry.overwrite;
    plan.tables[name] = entry;
  }

  plan.writtenServerIDs = [...written].sort((a, b) => a - b);
  plan.overwrittenServerIDs = [...overwritten].sort((a, b) => a - b);
  plan.skippedServerIDs = [...skipped].sort((a, b) => a - b);
  return plan;
}

/**
 * Upper bound on the ids recorded in `containedServerIDs`.
 *
 * The honest value of that field is one entry per server in the community,
 * so a handful. A cap is here because the field is built from row data: a
 * table whose scope column holds something other than a server id — a
 * misclassified model, a column that was repurposed — would otherwise turn
 * a hundred-million-row export into a hundred-million-entry array in the
 * envelope header. Overflowing sets `containedServerIDsTruncated`, which is
 * a louder signal that something is wrong than a giant array would be.
 */
const MAX_CONTAINED_SERVER_IDS = 64;

/**
 * Record one row's server id, if it has a usable one.
 *
 * Nulls are skipped rather than recorded as a distinct "unattributed"
 * entry: a null here is a pre-multi-server row, and the import side already
 * has a rule for those (makeServerIDStamper attributes them to whoever runs
 * the restore). Listing them in `containedServerIDs` would put a value in
 * the field that names no server.
 *
 * @param {Set<number>} set
 * @param {*} value - The raw column value
 * @returns {boolean} False once the cap is reached and the value was dropped
 */
function noteServerID(set, value) {
  if (value === null || value === undefined) return true;
  const id = Number(value);
  if (!Number.isFinite(id)) return true;
  if (set.has(id)) return true;
  if (set.size >= MAX_CONTAINED_SERVER_IDS) return false;
  set.add(id);
  return true;
}

/**
 * How one model's rows narrow to one server during an export.
 *
 * Wraps DBService.scopePredicateFor() with the one behaviour an exporter
 * needs on top of it: an undeclared model is fatal for a scoped export and
 * harmless for a community-wide one. A community-wide export applies no
 * predicate at all, so not knowing the classification costs nothing; a
 * scoped export that swallowed the error would ship a sibling's rows inside
 * a file labelled as one server's.
 *
 * @param {object} dbService
 * @param {string} name - Model name
 * @param {boolean} allServers
 * @returns {{column: string, value: number}|null}
 */
function exportScopeFor(dbService, name, allServers) {
  try {
    return dbService.scopePredicateFor?.(name) ?? null;
  } catch (err) {
    if (!allServers) throw err;
    return null;
  }
}

// ─── HELPERS ──────────────────────────────────────────────

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
 * Which models an export was asked for but did not actually deliver, split by
 * whether the envelope says so.
 *
 * ─── WHY THIS EXISTS ───
 *
 * An export's `results` map is per-model, and every entry in it is an entry the
 * exporter knew to write. Nothing has ever compared that map against what was
 * asked for, so a model can go missing in a way that leaves no trace at all: it
 * was named in an explicit `models` list, is not in the registry,
 * `filterByTier()` dropped it, and it then appears nowhere — not in `tables`,
 * not in `results`, not as an error. Every line of the envelope says `ok` and
 * the table is simply not in the backup.
 *
 * That is the case this exists for, and it is why the comparison is against the
 * REQUESTED set rather than against `filterByTier()`'s output. Comparing the
 * envelope to the filtered list is a tautology: the filter is what built it.
 *
 * ─── WHY A FAILED READ IS NOT THE SAME THING ───
 *
 * A table that errored is already in `results` with its driver message, so the
 * envelope is not lying about it — it is loud, and it is returned separately as
 * `failed`. It also has a legitimate cause that a backup must survive: drift
 * repair. When a column a model declares is missing from the live table, every
 * read of that model fails, and the migration that fixes it is the one about to
 * run. Treating that as "no backup, refuse to migrate" would make the repair
 * path unreachable on exactly the databases that need it.
 *
 * @param {string[]} requested - Model names the export was supposed to cover
 * @param {Record<string, {status: string, error?: string}>} results
 * @returns {{missing: Array<{model: string, reason: string}>, failed: Array<{model: string, reason: string}>}}
 */
export function findEnvelopeGaps(requested, results = {}) {
  const missing = [];
  const failed = [];
  for (const name of requested) {
    const entry = results[name];
    if (!entry) {
      missing.push({ model: name, reason: 'not in the registry — nothing was exported for it' });
    } else if (entry.status !== 'ok') {
      failed.push({ model: name, reason: entry.error || entry.status });
    }
  }
  return { missing, failed };
}

/**
 * Which of these models have no table in the database yet.
 *
 * ─── WHY A MISSING TABLE IS NOT A GAP ───
 *
 * The pre-migration backup is scoped from `touches`, and a migration group
 * routinely creates a table at v1 and changes it at v2. Both are pending on a
 * fresh install, so the export is asked for a model whose table does not exist
 * yet and comes back with the driver's "no such table". That reads exactly like
 * a failed read of a real table, and it is the opposite: there is nothing there
 * to lose, so there is nothing a backup could have protected.
 *
 * Answered from `showAllTables()` rather than from the error string, which is a
 * different sentence on each of the three engines.
 *
 * @param {object} dbService
 * @param {string[]} modelNames
 * @returns {Promise<Set<string>>} The subset whose table is absent
 */
export async function findAbsentTables(dbService, modelNames) {
  const absent = new Set();
  if (modelNames.length === 0) return absent;

  const connector = dbService?.getConnector?.();
  if (!connector || typeof connector.getQueryInterface !== 'function') return absent;

  let live;
  try {
    live = await connector.getQueryInterface().showAllTables();
  } catch {
    // Cannot tell. Leave every gap standing — the safe direction here is to
    // report a backup as incomplete when it might be.
    return absent;
  }

  // Prod MySQL runs lower_case_table_names=1, so the comparison folds.
  const present = new Set(live.map((t) => String(t?.tableName ?? t).toLowerCase()));
  for (const name of modelNames) {
    const model = dbService.getModel?.(name);
    if (!model) continue; // unregistered: a genuine gap, not an absent table
    if (!present.has(String(model.tableName || model.name).toLowerCase())) absent.add(name);
  }
  return absent;
}

/**
 * Tables that exist in the database and that no exported model covers.
 *
 * ─── WHY THE REGISTRY IS NOT ENOUGH ───
 *
 * `findEnvelopeGaps()` answers "did the export deliver what it was asked for",
 * and the answer is bounded by the registry — which is whatever `defineModel()`
 * happened to run in THIS process. A plugin that is installed but not mounted
 * registers nothing, so its tables are not requested, not exported, and not
 * missing: they are invisible, and every line of the envelope still says `ok`.
 *
 * That is not hypothetical. An archived production export carries seventeen
 * models at `tier: "all"`, all `ok`, and `core-plugins/db-log.js`'s eight tables
 * appear in none of them — while `S3_SchemaVersions` inside that same file
 * records db-log migrated hours earlier. The artifact cannot distinguish "the
 * exporter never saw those models" from "the plugin was unmounted in between",
 * and it had no way to say either.
 *
 * The database is the only thing that knows. So for an export that claims to be
 * the whole database, ask it.
 *
 * ─── WHY THIS IS A WARNING AND NOT A FAILURE ───
 *
 * A shared database legitimately holds tables this suite does not own — core
 * SquadJS, other plugins, the operator's own. Refusing to export because they
 * exist would be wrong, and on a live install it would refuse every time. What
 * is wrong is claiming an S³ export is a backup of the database without saying
 * which tables it left out. So this names them and lets the caller decide.
 *
 * @param {object} dbService
 * @param {string[]} exportedModelNames - Models that actually landed in the envelope
 * @returns {Promise<string[]>} Table names, as the database spells them
 */
export async function findUnexportedTables(dbService, exportedModelNames) {
  const connector = dbService?.getConnector?.();
  if (!connector || typeof connector.getQueryInterface !== 'function') return [];

  let live;
  try {
    live = await connector.getQueryInterface().showAllTables();
  } catch {
    // Not every connector answers this, and an export that cannot enumerate the
    // database is not thereby a failed export — it is one that cannot make the
    // stronger claim. Say nothing rather than something false.
    return [];
  }

  // Prod MySQL runs lower_case_table_names=1, so every comparison here folds.
  const covered = new Set();
  for (const name of exportedModelNames) {
    const model = dbService.getModel?.(name);
    if (model) covered.add(String(model.tableName || model.name).toLowerCase());
  }

  return live
    .map((t) => String(t?.tableName ?? t))
    .filter((t) => !covered.has(t.toLowerCase()));
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
 * ⚠️ **Must be given the transaction that does the writing.** These are SESSION
 * variables, and every statement here goes through Sequelize's connection pool,
 * so issued bare they land on whichever connection happens to be free and the
 * upserts then run on a different one with checks still enabled. A Sequelize
 * transaction holds one connection for its whole life, so passing the handle is
 * what makes the suppression reach the rows it is meant to cover. This is the
 * same mistake the advisory lock made — a session-scoped primitive issued
 * through a pool — and it was found by grepping for the pattern rather than by
 * hitting the symptom.
 *
 * On Postgres it is not merely safer but load-bearing: `SET CONSTRAINTS ALL
 * DEFERRED` only applies within the current transaction, so outside one the
 * fallback path does nothing whatsoever.
 *
 * @param {import('sequelize').Sequelize} connector
 * @param {(level: number, msg: string) => void} [verboseLogger]
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<void>}
 */
async function disableForeignKeyChecks(connector, verboseLogger = () => {}, transaction = null) {
  if (!connector || typeof connector.query !== 'function') return;
  const dialect = typeof connector.getDialect === 'function' ? connector.getDialect() : 'sqlite';
  const opts = transaction ? { transaction } : {};

  if (dialect === 'postgres') {
    try {
      await connector.query('SET session_replication_role = replica', opts);
    } catch (err) {
      verboseLogger(2, `[ExportImport] session_replication_role unavailable (${err.message}) — falling back to SET CONSTRAINTS ALL DEFERRED. FK checks are only deferred for DEFERRABLE constraints.`);
      await connector.query('SET CONSTRAINTS ALL DEFERRED', opts);
    }
  } else if (dialect === 'mysql') {
    await connector.query('SET FOREIGN_KEY_CHECKS = 0', opts);
  }
  // SQLite: FK checks are off by default — no-op
}

/**
 * Re-enable foreign key constraint checks after an import transaction.
 * Mirrors disableForeignKeyChecks(), including the Postgres fallback.
 *
 * Takes the same transaction handle, and for a second reason: MySQL does not
 * reset session variables when a connection returns to the pool, so a
 * connection released with `FOREIGN_KEY_CHECKS = 0` stays that way for whatever
 * borrows it next. Restoring on the same connection that disabled it is what
 * stops the suppression outliving the import.
 *
 * @param {import('sequelize').Sequelize} connector
 * @param {(level: number, msg: string) => void} [verboseLogger]
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<void>}
 */
async function enableForeignKeyChecks(connector, verboseLogger = () => {}, transaction = null) {
  if (!connector || typeof connector.query !== 'function') return;
  const dialect = typeof connector.getDialect === 'function' ? connector.getDialect() : 'sqlite';
  const opts = transaction ? { transaction } : {};

  if (dialect === 'postgres') {
    try {
      await connector.query('SET session_replication_role = DEFAULT', opts);
    } catch (err) {
      verboseLogger(2, `[ExportImport] Could not restore session_replication_role (${err.message}) — restoring constraints via SET CONSTRAINTS ALL IMMEDIATE.`);
      await connector.query('SET CONSTRAINTS ALL IMMEDIATE', opts);
    }
  } else if (dialect === 'mysql') {
    await connector.query('SET FOREIGN_KEY_CHECKS = 1', opts);
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
 * `allServers: false` adds a WHERE to every server-scoped table. Global
 * tables are exported whole regardless, because there is no per-server
 * subset of them — which also means a "one server" envelope still carries
 * community-wide rows, and an import of it still touches the community.
 *
 * @param {object} dbService - DBService instance
 * @param {object} [options]
 * @param {string} [options.tier='historical'] - 'historical', 'logs', or 'all'
 * @param {string[]|null} [options.models=null] - Explicit model allowlist
 * @param {boolean} [options.allServers=true] - False narrows to this server
 * @returns {Promise<object>} { tables, rowCounts, results, complete, s3ExportVersion, exportedAt, connector, serverID, scope, containedServerIDs }
 */
export async function exportToJSON(dbService, { tier = 'historical', models = null, allServers = true } = {}) {
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
    // Who took it and what it claims to cover. `scope` is the operator's
    // intent and `containedServerIDs` is what the rows actually say, and they
    // are separate fields because they disagree in the case that matters: a
    // scoped export of a table whose serverID column has not landed yet
    // contains rows attributed to nobody.
    serverID: dbService.getServerID?.() ?? null,
    scope: allServers ? 'community' : 'server',
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

  const contained = new Set();
  let truncated = false;

  for (const name of present) {
    const model = dbService.getModel(name);
    try {
      const scope = exportScopeFor(dbService, name, allServers);
      const query = { raw: true };
      if (scope && !allServers) query.where = { [scope.column]: scope.value };
      const rows = await model.findAll(query);
      if (scope) {
        for (const row of rows) {
          if (!noteServerID(contained, row[scope.column])) { truncated = true; break; }
        }
      }
      result.tables[name] = rows;
      result.rowCounts[name] = rows.length;
      result.results[name] = { status: 'ok', rows: rows.length };
    } catch (err) {
      result.results[name] = { status: 'error', error: err.message };
    }
  }

  result.containedServerIDs = [...contained].sort((a, b) => a - b);
  if (truncated) result.containedServerIDsTruncated = true;

  await _stampCoverage(dbService, result, { requested: models, selected, tier, results: result.results });

  return result;
}

/**
 * Record, on the envelope itself, how much of what it claims to cover it
 * actually covers. Shared by both exporters so the two cannot drift.
 *
 * Three fields, kept separate on purpose because they carry different weight:
 *
 *   `complete` / `incomplete`   The hard signal, and the narrow one: a model the
 *                               export was asked for that left no trace in the
 *                               envelope at all. A caller treating this file as
 *                               a safety net — the pre-migration backup — must
 *                               refuse it when this is false.
 *   `failedTables`              A table the exporter tried and could not read.
 *                               Loud already, since its driver message is in
 *                               `results`, and survivable: a drifted table fails
 *                               every read until the migration repairs it.
 *   `unexportedTables`          Informational, and only for an export claiming
 *                               the whole database. Names tables the process
 *                               could not have exported because nothing
 *                               registered a model for them. A shared database
 *                               has these legitimately, so it is a warning.
 */
async function _stampCoverage(dbService, envelope, { requested, selected, tier, results }) {
  const asked = Array.isArray(requested) && requested.length > 0 ? requested : selected;
  const { missing, failed } = findEnvelopeGaps(asked, results);

  envelope.complete = missing.length === 0;
  if (missing.length > 0) envelope.incomplete = missing;

  if (failed.length > 0) {
    // A table the database does not have yet is not a failure worth reporting.
    // This is the ordinary shape of a fresh install: v1 creates the table, v2
    // changes it, both are pending, and the backup is scoped from the union of
    // what they touch — so the export is asked for a table that will not exist
    // until the run it is protecting.
    const absent = await findAbsentTables(dbService, failed.map((g) => g.model));
    if (absent.size > 0) envelope.absentTables = [...absent];
    const real = failed.filter((g) => !absent.has(g.model));
    if (real.length > 0) envelope.failedTables = real;
  }

  // Only an export with no model allowlist, at the widest tier, is claiming to
  // be the database. A scoped or tiered export never made that claim, and
  // listing "unexported" tables against it would be noise.
  const claimsWholeDatabase = !(Array.isArray(requested) && requested.length > 0) && tier === 'all';
  if (!claimsWholeDatabase) return;

  const exported = Object.keys(results).filter((name) => results[name]?.status === 'ok');
  const unexported = await findUnexportedTables(dbService, exported);
  if (unexported.length === 0) return;

  envelope.unexportedTables = unexported;
  envelope.warnings = envelope.warnings || [];
  envelope.warnings.push(
    `This export covers ${exported.length} registered model(s) and is NOT a backup of the database: ` +
    `${unexported.length} table(s) present in it have no registered model and were not exported — ` +
    `${unexported.join(', ')}. Tables owned by other plugins appear here whenever those plugins are ` +
    'not mounted in this process.'
  );
}

/**
 * Import rows from a previously exported JSON object.
 *
 * Validates structure, then upserts each row inside a single Sequelize
 * transaction. Per-table try-catch allows partial recovery — a failing
 * table does not abort previously imported tables. FK checks are
 * disabled for the transaction duration.
 *
 * Rows belonging to a sibling server are SKIPPED unless the caller asks for
 * them, and the two ways of asking mean different things — see
 * makeImportPolicy(). Rows carrying no server id are adopted by this server
 * whatever the flags say, because that is every pre-multi-server backup.
 *
 * The returned `plan` is what the write was agreed to on the strength of:
 * per table, how many rows are written, adopted, remapped, left with a
 * sibling, skipped, and — the one an operator most needs — overwritten, with
 * the servers those existing rows currently belong to.
 *
 * @param {object} dbService - DBService instance
 * @param {object} json - The export object from exportToJSON()
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, validate only (no writes)
 * @param {function} [options.localize] - Message lookup; pass plugin.localize
 *                                        when the result is rendered to Discord
 * @param {boolean} [options.allServers=false] - Write foreign rows as they are
 * @param {boolean} [options.remapServer=false] - Rewrite foreign rows to this server
 * @returns {Promise<{ imported: object, errors: string[], plan: object }>}
 */
export async function importFromJSON(dbService, json, {
  dryRun = false,
  localize = localizeEn,
  allServers = false,
  remapServer = false
} = {}) {
  if (!dbService || !dbService.isReady()) {
    throw new Error('DBService is not ready.');
  }

  // Two different intentions, not two degrees of one. `--all-servers` restores
  // each row to the server it names; `--remap-server` folds every row onto this
  // one. An operator who typed both has not said which, and guessing picks
  // between "leave rows nothing on this install can read" and "merge two
  // servers' histories" on their behalf.
  if (allServers && remapServer) {
    return { imported: {}, errors: [localize('slackersSquadServices.db.importFlagsConflict')] };
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

  // Worked out before anything is written, and returned either way. A dry run
  // renders it as the confirmation; a real run carries it so the summary can
  // say what the write was agreed to on the strength of.
  const plan = await planImport(dbService, json, { allServers, remapServer });
  result.plan = plan;

  /** Turn one table's plan entry into the line the caller reports. */
  const reportFor = (name, entry, extra = {}) => {
    if (entry.status === 'skipped') {
      return {
        status: 'skipped',
        rows: 0,
        reason: localize('slackersSquadServices.db.importNotRestorable', { table: name }),
        ...extra
      };
    }
    if (entry.status === 'unknown') {
      // Loud, and per table. This used to be a warning in a list beside a
      // per-table "Model not found", inside a result whose other lines were
      // ticks — which is how a whole table goes missing from a restore that
      // reads as a success.
      return {
        status: 'error',
        rows: 0,
        error: localize('slackersSquadServices.db.importNoModelForTable', { table: name, rows: String(entry.total) }),
        ...extra
      };
    }
    if (entry.status === 'error') {
      return { status: 'error', rows: 0, error: entry.error, ...extra };
    }
    return {
      status: 'ok',
      rows: entry.write + entry.stamp + entry.remap + entry.foreign,
      ...(entry.stamp > 0 ? { stamped: entry.stamp } : {}),
      ...(entry.remap > 0 ? { remapped: entry.remap } : {}),
      ...(entry.foreign > 0 ? { foreign: entry.foreign } : {}),
      ...(entry.skip > 0 ? { skippedRows: entry.skip, skippedServerIDs: entry.skipServerIDs } : {}),
      ...(entry.overwrite ? { overwrite: entry.overwrite, overwriteServerIDs: entry.overwriteServerIDs } : {}),
      ...extra
    };
  };

  if (dryRun) {
    // A dry run has to predict the real run exactly, which is why both read the
    // same plan rather than each deciding the rules for themselves.
    for (const [name, entry] of Object.entries(plan.tables)) {
      result.imported[name] = reportFor(name, entry, { dryRun: true });
    }
    return result;
  }

  /**
   * Write one table's importable rows, re-deriving the same decisions the plan
   * made. Re-derived rather than carried: the rows are already in memory here,
   * and holding a second copy of every table alongside the envelope is what
   * this module spent a release learning not to do.
   */
  const writeTable = async (name, model, transaction) => {
    const policy = makeImportPolicy(dbService, name, model, { allServers, remapServer });
    let written = 0;
    for (const row of json.tables[name]) {
      const decision = policy.classify(row);
      if (decision.action === IMPORT_ROW_ACTIONS.SKIP) continue;
      await model.upsert(decision.row, transaction ? { transaction } : {});
      written += 1;
    }
    return written;
  };

  /** Every table's write, in envelope order, with per-table isolation. */
  const importAll = async (transaction) => {
    for (const [name, entry] of Object.entries(plan.tables)) {
      if (entry.status !== 'ok') {
        result.imported[name] = reportFor(name, entry);
        continue;
      }

      const model = dbService.getModel(name);
      try {
        const written = await writeTable(name, model, transaction);
        result.imported[name] = reportFor(name, entry, { rows: written });
      } catch (err) {
        result.imported[name] = { status: 'error', error: err.message };
      }
    }
  };

  if (connector && typeof connector.transaction === 'function') {
    const fkLogger = typeof dbService.verboseLogger === 'function' ? dbService.verboseLogger : () => {};
    await connector.transaction(async (transaction) => {
      // Inside the transaction, not around it. These are session variables and
      // every statement goes through the pool — see disableForeignKeyChecks().
      await disableForeignKeyChecks(connector, fkLogger, transaction);
      try {
        await importAll(transaction);
      } finally {
        // Before the connection goes back to the pool, not after.
        await enableForeignKeyChecks(connector, fkLogger, transaction);
      }
    });
  } else {
    // Fallback: no transaction support — upsert directly
    await importAll(null);
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
 * A scope predicate is combined with the cursor under `Op.and` rather than
 * merged into one object, because for a `server-key` model the two clauses
 * name the SAME column — the primary key IS the server id — and a plain
 * spread would drop whichever clause was written first.
 *
 * @param {object} model - Sequelize model
 * @param {number} batchSize
 * @param {object|null} [where] - Scope predicate applied to every page
 * @yields {object[]} A batch of raw rows
 */
async function* _iterateRowBatches(model, batchSize, where = null) {
  const pkAttrs = Array.isArray(model.primaryKeyAttributes) ? model.primaryKeyAttributes : [];
  const Op = model.sequelize?.constructor?.Op || model.sequelize?.Sequelize?.Op || SequelizeLib.Op;
  const pk = pkAttrs.length === 1 && Op ? pkAttrs[0] : null;

  if (pk) {
    let last = null;
    for (;;) {
      const query = { raw: true, order: [[pk, 'ASC']], limit: batchSize };
      const clauses = [];
      if (where) clauses.push(where);
      if (last !== null) clauses.push({ [pk]: { [Op.gt]: last } });
      if (clauses.length === 1) query.where = clauses[0];
      else if (clauses.length > 1) query.where = { [Op.and]: clauses };
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
      const query = { raw: true, limit: batchSize, offset };
      if (where) query.where = where;
      const rows = await model.findAll(query);
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
 * @param {boolean} [options.allServers=true] - False narrows to this server
 * @param {(level:number,msg:string)=>void} [options.verboseLogger]
 * @returns {Promise<{ filename: string, path: string, sizeBytes: number, rowCounts: object, results: object, warnings: string[], complete: boolean, incomplete?: Array<{model: string, reason: string}>, unexportedTables?: string[], connector: string, tier: string }|null>}
 */
export async function exportToFile(dbService, backupDir = null, {
  tier = 'all',
  retention = 5,
  models = null,
  batchSize = DEFAULT_BATCH_SIZE,
  // Community-wide by default, unlike the operator-facing `!s3 db export`.
  // The first caller of this function is MigrationEngine's pre-migration
  // backup, and a shared schema migrates for every server at once — a backup
  // holding one server's rows would be no use to the restore that needs it.
  allServers = true,
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

  // Filled in by _stampCoverage() once the tables have streamed, then written
  // into the tail of the file and returned to the caller.
  const coverage = { warnings };

  // Accumulated while streaming rather than queried, so it costs nothing on
  // top of a pass the export was making anyway.
  const contained = new Set();
  let truncated = false;

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
    await w.write(`  "serverID": ${JSON.stringify(dbService.getServerID?.() ?? null)},\n`);
    await w.write(`  "scope": ${JSON.stringify(allServers ? 'community' : 'server')},\n`);
    await w.write(`  "tier": ${JSON.stringify(tier)},\n`);
    await w.write(`  "tiers": ${JSON.stringify(Object.fromEntries(selected.map((n) => [n, dbService.getEffectiveModelTier(n)])))},\n`);
    // `warnings` is written in the tail, not here: the coverage assertion below
    // can only be made once every table has streamed, and one warnings array is
    // easier to read than two keys that mean the same thing.
    await w.write('  "tables": {\n');

    let firstTable = true;
    for (const name of present) {
      if (!firstTable) await w.write(',\n');
      firstTable = false;
      await w.write(`    ${JSON.stringify(name)}: [\n`);

      const model = dbService.getModel(name);
      let count = 0;
      try {
        const scope = exportScopeFor(dbService, name, allServers);
        const where = scope && !allServers ? { [scope.column]: scope.value } : null;
        for await (const batch of _iterateRowBatches(model, batchSize, where)) {
          let chunk = '';
          for (const row of batch) {
            chunk += (count === 0 ? '' : ',\n') + JSON.stringify(row);
            count += 1;
            if (scope && !noteServerID(contained, row[scope.column])) truncated = true;
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

    // Coverage goes in the file, not only in the return value. The return value
    // is gone the moment the command that took the backup finishes; the file is
    // what somebody reads six months later while deciding whether to trust it.
    await _stampCoverage(dbService, coverage, { requested: models, selected, tier, results });

    await w.write(`  "containedServerIDs": ${JSON.stringify([...contained].sort((a, b) => a - b))},\n`);
    if (truncated) await w.write('  "containedServerIDsTruncated": true,\n');
    await w.write(`  "rowCounts": ${JSON.stringify(rowCounts)},\n`);
    if (coverage.warnings.length > 0) await w.write(`  "warnings": ${JSON.stringify(coverage.warnings)},\n`);
    await w.write(`  "complete": ${JSON.stringify(coverage.complete)},\n`);
    if (coverage.incomplete) await w.write(`  "incomplete": ${JSON.stringify(coverage.incomplete)},\n`);
    if (coverage.absentTables) await w.write(`  "absentTables": ${JSON.stringify(coverage.absentTables)},\n`);
    if (coverage.failedTables) await w.write(`  "failedTables": ${JSON.stringify(coverage.failedTables)},\n`);
    if (coverage.unexportedTables) await w.write(`  "unexportedTables": ${JSON.stringify(coverage.unexportedTables)},\n`);
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
    warnings: coverage.warnings,
    complete: coverage.complete,
    incomplete: coverage.incomplete,
    absentTables: coverage.absentTables,
    failedTables: coverage.failedTables,
    unexportedTables: coverage.unexportedTables,
    connector: connectorName,
    tier,
    serverID: dbService.getServerID?.() ?? null,
    scope: allServers ? 'community' : 'server',
    containedServerIDs: [...contained].sort((a, b) => a - b),
    containedServerIDsTruncated: truncated || undefined
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
      // explicitly to every call inside it. That includes the FK suppression:
      // this path has no single enclosing transaction to hang it on, so each
      // chunk suppresses and restores on its own pinned connection. Slightly
      // more statements than one bare SET at the top; the bare SET reached a
      // connection the writes never used.
      await connector.transaction(async (transaction) => {
        if (!dryRun) await disableForeignKeyChecks(connector, fkLogger, transaction);
        try {
          for (const row of rows) await model.upsert(row, { transaction });
        } finally {
          if (!dryRun) await enableForeignKeyChecks(connector, fkLogger, transaction);
        }
      });
    } else {
      for (const row of rows) await model.upsert(row);
    }
  };

  const input = fs.createReadStream(backupPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let inTables = false;
  /** @type {{name:string, model:object|null, skipped:boolean, buffer:object[], count:number, stamped:number, stamp:(row:object)=>object, failed:boolean}|null} */
  let current = null;

  const finishTable = async () => {
    if (!current) return;
    if (current.skipped) {
      result.imported[current.name] = {
        status: 'skipped',
        rows: 0,
        reason: localize('slackersSquadServices.db.importNotRestorable', { table: current.name }),
        ...(dryRun ? { dryRun: true } : {})
      };
      current = null;
      return;
    }
    if (current.model && !current.failed) {
      try {
        await upsertChunk(current.model, current.buffer);
        result.imported[current.name] = { status: 'ok', rows: current.count, ...(dryRun ? { dryRun: true } : {}), ...(current.stamped > 0 ? { stamped: current.stamped } : {}) };
      } catch (err) {
        result.imported[current.name] = { status: 'error', error: err.message, rows: current.count };
      }
    } else if (!current.model) {
      result.imported[current.name] = { status: 'error', error: 'Model not found' };
    }
    current = null;
  };

  // FK suppression lives in upsertChunk(), pinned to each chunk's transaction —
  // issued here it would land on a pooled connection the writes never touch.
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
          const skipped = IMPORT_SKIPPED_MODELS.has(name);
          // A skipped table carries no model deliberately: every guard below
          // already declines to parse or buffer rows for a table without one,
          // so the skip costs one flag rather than a second condition on each
          // of them. The flag is what keeps it out of the unknown-table
          // warning — being passed over on purpose is not a malformed file.
          const model = (!skipped && known.has(name)) ? dbService.getModel(name) : null;
          if (!model && !skipped) {
            result.errors.push(localize('slackersSquadServices.db.importUnknownTableSkippedStream', { table: name }));
          }
          current = {
            name,
            model,
            skipped,
            buffer: [],
            count: 0,
            stamped: 0,
            // Resolved once per table rather than per row: the scope lookup and
            // the attribute check do not change between rows, and this path
            // exists for files with millions of them.
            stamp: model ? makeServerIDStamper(dbService, name, model) : (row) => row,
            failed: false
          };
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

      // Stamped at buffer time, not at write time, so a dry run counts what a
      // real run would stamp without writing anything.
      const toWrite = current.stamp(row);
      if (toWrite !== row) current.stamped += 1;
      current.buffer.push(toWrite);
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

    // The one operation here whose honest answer is "unsafe" rather than
    // "unrouted". A .sqlite restore is fs.copyFileSync() over the database
    // file, and a sibling process holds that same file open with its own page
    // cache and its own write-ahead log. Replacing it underneath that process
    // does not roll it back — it leaves it reading pages that no longer belong
    // to the file it thinks it opened, and the damage surfaces minutes later
    // as unreadable rows rather than as an error anyone can connect to this
    // command. So it is refused rather than warned about. The refusal lifts
    // itself: stop the other servers, and their heartbeats lapse out of the
    // freshness window on their own.
    let liveSiblings = [];
    try {
      if (dbService && typeof dbService.getLiveServers === 'function') {
        const me = dbService.getServerID();
        liveSiblings = (await dbService.getLiveServers()).filter((row) => row.serverID !== me);
      }
    } catch {
      // A registry that cannot be read looks like the single-server case from
      // here, and refusing every restore because the check itself failed would
      // cost more than the hazard it guards.
      liveSiblings = [];
    }
    if (liveSiblings.length > 0) {
      const who = liveSiblings.map((row) => `#${row.serverID}`).join(', ');
      throw new Error(
        `Refusing to restore ${filename} by file copy: ${liveSiblings.length} other server ` +
        `process${liveSiblings.length === 1 ? ' is' : 'es are'} live on this database (${who}). ` +
        'Overwriting the file underneath them corrupts it rather than rolling it back. Stop ' +
        'them and retry, or restore from a .json backup, which writes through the database ' +
        'instead of around it.'
      );
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

    // Community-wide, deliberately, and not the default `!s3 db import` uses.
    // An import takes a file an operator chose, so it narrows to this server
    // until told otherwise. A backup is not an arbitrary file: both
    // `!s3 backup create` and MigrationEngine's pre-migration backup write
    // every server's rows, and this is the path that puts them back. A
    // rollback that quietly omitted the siblings would restore a database that
    // never existed. The streaming path above reaches the same place through
    // makeServerIDStamper(), which writes each row back to the server it names.
    return importFromJSON(dbService, parsed, { dryRun: false, localize, allServers: true });
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

