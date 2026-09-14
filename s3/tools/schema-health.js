/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           SCHEMA HEALTH CHECKER                              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Offline SQLite schema health report. Connects directly to the
 * squad-server.sqlite database and checks that all expected S³
 * tables exist with their expected columns. Flags orphan tables
 * (present in DB but not expected by S³). Reports ✅/⚠️/❌ per table.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node tools/schema-health.js
 *   node tools/schema-health.js --db-path ./custom-path.sqlite
 *   node tools/schema-health.js --json          (machine-readable output)
 *
 * ─── TABLES CHECKED ──────────────────────────────────────────────
 *
 * Twenty tables — every table the suite still reads or writes:
 *   S3_*            — core S³ (9, including S3_SchemaVersions, S3_Locks and S3_Servers)
 *   SwitchPlugin_*  — Switch (5)
 *   Elo_*           — EloTracker (3)
 *   TB_ and TeamBalancerState — TeamBalancer (2)
 *   SA_*            — SmartAssign (1)
 *
 * Plus four ABANDONED tables, reported for information and never as a
 * problem. Multi-server support moved three tables to a composite primary
 * key, and a primary key cannot be altered in place on either engine that
 * matters — SQLite has no statement that reaches one and the deployed MySQL
 * grant has no ALTER — so each became a new table beside the old one. The
 * old ones are still created on a fresh install, because the migrations that
 * create them are recorded in production and a recorded migration is a
 * contract. Nothing reads them.
 *
 * Plus orphan detection: any table carrying one of the suite's prefixes that
 * exists in the DB but is in neither list is flagged.
 *
 * ⚠️ The column lists below are the CONTRACT this tool checks against, and a
 * wrong one fails in the direction that looks like a healthy report. Derive them
 * by running the plugins' registration code against an empty database and
 * reading the models back — never by transcribing them from a design document or
 * from another copy of this list. Checked that way on 2026-09-05, this file was
 * reporting six failures and four warnings against a database that was entirely
 * correct: a renamed table (`Elo_RoundHistory` → `Elo_RoundHistories`), four
 * tables it had never been told about, and a `S3_GameState` column list from a
 * schema that no longer exists.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * sqlite3 (via better-sqlite3 or default sqlite3 package).
 * Falls back to sequelize if available.
 *
 */

// ESM, not CommonJS. The repo's package.json sets "type": "module", so a .js
// file using require() throws ReferenceError at load and the tool never runs at
// all — which is how it sat broken behind a doc disclaimer that described a
// subtler failure (every table reported missing) that nobody could have seen.
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Sequelize } from 'sequelize';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Expected Tables ──────────────────────────────────────────────
//
// Each entry: { table, expectedColumns[] }
// Columns listed are the ones we expect to find (subset). The checker
// verifies column names not exact types, since SQLite column types
// are advisory.

const EXPECTED_TABLES = [
  {
    table: 'S3_GameState',
    columns: ['id', 'phase', 'resolving', 'lastPhaseChangeAt', 'lastNewGameAt',
              'lastRoundEndedAt', 'lastLayerName', 'lastGamemode', 'roundStartTime', 'matchId'],
    owner: 'S³ core (GameStateService)',
    note: 'Central round state for crash recovery'
  },
  {
    table: 'S3_SchemaVersions',
    columns: ['id', 'pluginName', 'version', 'appliedAt', 'migrationHash', 'description'],
    owner: 'S³ core (DBService)',
    note: 'Per-plugin schema version tracking (7.4b)'
  },
  {
    table: 'S3_Locks',
    columns: ['lockKey', 'kind', 'owner', 'acquiredAt', 'expiresAt'],
    owner: 'S³ core (DBService)',
    note: 'Cross-process coordination; one row per held lock, per-row TTL'
  },
  {
    table: 'S3_Servers',
    columns: ['serverID', 'alias', 'serverName', 'host', 'queryPort', 'rconPort',
              'suiteVersion', 'firstSeenAt', 'lastSeenAt', 'clockSkewMs', 'communityOptions'],
    owner: 'S³ core (DBService)',
    note: 'Server registry — who else writes to this database'
  },
  {
    table: 'S3_ServerReconnects',
    columns: ['serverID', 'eosID', 'steamID', 'playerName', 'lastTeamID', 'lastSeenAt', 'updatedAt'],
    owner: 'S³ core (PlayersService)',
    note: 'Last known team, for reconnect handling. PK (serverID, eosID)'
  },
  {
    table: 'S3_ServerSessions',
    columns: ['serverID', 'eosID', 'steamID', 'playerName', 'sessionStart', 'lastActivity'],
    owner: 'S³ core (PlayersService)',
    note: 'Session clocks, rebuilt from live play after a restart. PK (serverID, eosID)'
  },
  {
    table: 'S3_PlayerEvents',
    columns: ['id', 'serverID', 'matchId', 'roundStartTime', 'ts', 'eventType', 'eosID',
              'steamID', 'name', 'teamID', 'squadID', 'oldTeamID', 'newTeamID',
              'source', 'betweenRounds', 't1', 't2'],
    owner: 'S³ core (LoggingService)',
    note: 'Cross-plugin player event stream (7.4h)'
  },
  {
    table: 'S3_GameStateEvents',
    columns: ['id', 'serverID', 'matchId', 'ts', 'eventType', 'oldPhase', 'newPhase',
              'resolving', 'layerName', 'gamemode'],
    owner: 'S³ core (LoggingService)',
    note: 'Phase transition event stream (7.4h)'
  },
  {
    table: 'S3_PlayerSnapshots',
    columns: ['id', 'serverID', 'matchId', 'ts', 'trigger', 'playersJson', 't1', 't2'],
    owner: 'S³ core (LoggingService)',
    note: 'Full roster snapshots at LIVE/MID_ROUND/ENDGAME (7.4h)'
  },
  {
    table: 'SA_AssignmentLog',
    columns: ['id', 'serverID', 'matchId', 'roundStartTime', 'ts', 'eventType', 'eosID',
              'steamID', 'name', 'targetTeamID', 'reason', 'attempt', 'method', 'metadata'],
    owner: 'SmartAssign',
    note: 'SA-specific assignment decisions (7.4i)'
  },
  {
    table: 'SwitchPlugin_PlayerCooldowns',
    // Four of these — scrambleLockdownExpiry, seedPresenceStart,
    // lastSeedBonusRoundID and seedBonusTokensEarned — are no longer declared
    // by the model. They stay listed because this tool checks the TABLE, and
    // the table still has them: the split moved the reads and writes to
    // SwitchPlugin_PlayerServerState and left the columns in place, since the
    // live MySQL user cannot ALTER and a dropped column is the one step a
    // rollback cannot undo. Removing them here would report a correct
    // database as carrying four unexpected extras.
    columns: ['eosID', 'steamID', 'playerName', 'lastSwitchTimestamp', 'firstSeenTimestamp',
              'scrambleLockdownExpiry', 'tokenBalance', 'tokenRegenAnchor', 'seedPresenceStart',
              'lastSeedBonusRoundID', 'seedBonusTokensEarned', 'lastActiveTimestamp'],
    owner: 'Switch',
    note: 'Per-player switch token balances (community-wide since the split)'
  },
  {
    table: 'SwitchPlugin_PlayerServerState',
    columns: ['serverID', 'eosID', 'scrambleLockdownExpiry', 'seedPresenceStart',
              'lastSeedBonusRoundID', 'seedBonusTokensEarned', 'lastActiveTimestamp'],
    owner: 'Switch',
    note: 'Per-server scramble locks and seed clocks, PK (serverID, eosID)'
  },
  {
    table: 'SwitchPlugin_Endmatches',
    columns: ['id', 'serverID', 'name', 'steamID', 'eosID', 'created_at'],
    owner: 'Switch',
    note: 'End-of-match switch requests'
  },
  {
    table: 'SwitchPlugin_ServerSettings',
    columns: ['serverID', 'key', 'value'],
    owner: 'Switch',
    note: 'Runtime-editable Switch settings, per server. PK (serverID, key)'
  },
  {
    table: 'SwitchPlugin_RoundStats',
    columns: ['id', 'serverID', 'matchId', 'layerName', 'gameMode', 'roundEndedAt', 'liberalMode',
              'incomplete', 'source', 'success', 'failed', 'denied', 'toT1', 'toT2',
              'maxQueueSize', 'instant', 'queueNormal', 'queueTeamTrade', 'queueJoinSwap',
              'queueTimeoutSwitch', 'denialCooldown', 'denialTimeWindow', 'denialScrambleLock',
              'denialRecentSwitch', 'denialOther', 'outcomeExpired', 'outcomeDC',
              'outcomeCancelled', 'outcomeRemoved', 'meanQueueMs', 'medianQueueMs'],
    owner: 'Switch',
    note: 'Per-round switch outcome counters'
  },
  {
    table: 'Elo_PlayerStats',
    columns: ['eosID', 'steamID', 'discordID', 'name', 'mu', 'sigma',
              'wins', 'losses', 'roundsPlayed', 'lastSeen'],
    owner: 'EloTracker',
    note: 'Core Elo ratings'
  },
  {
    // Plural: the model is 'Elo_RoundHistories'. The singular spelling sat here
    // long enough to report a healthy database as missing a table.
    table: 'Elo_RoundHistories',
    columns: ['id', 'serverID', 'matchId', 'layerName', 'winningTeamID', 'ticketDiff',
              'roundDuration', 'endedAt', 'playerCount'],
    owner: 'EloTracker',
    note: 'Opt-in Elo round logging'
  },
  {
    table: 'Elo_RoundPlayers',
    columns: ['id', 'serverID', 'matchId', 'roundStartTime', 'roundHistoryId',
              'eosID', 'steamID', 'name', 'teamID', 'participationRatio',
              'muBefore', 'sigmaBefore', 'rawDeltaMu', 'rawDeltaSigma',
              'scaledDeltaMu', 'scaledDeltaSigma', 'muAfter', 'sigmaAfter'],
    owner: 'EloTracker',
    note: 'Opt-in per-player Elo deltas'
  },
  {
    table: 'TeamBalancerState',
    columns: ['id', 'winStreakTeam', 'winStreakCount', 'lastSyncTimestamp', 'lastScrambleTime',
              'consecutiveWinsTeam', 'consecutiveWinsCount', 'manuallyDisabled',
              'scrambleOnRoundEndBy'],
    owner: 'TeamBalancer',
    note: 'Core TB state (single row)'
  },
  {
    table: 'TB_RoundReport',
    columns: ['id', 'serverID', 'matchId', 'roundStartTime', 'ts', 'layerName', 'gameMode',
              'playerCount', 'winningTeamID', 'winnerName', 'loserName',
              'winnerTickets', 'loserTickets', 'ticketMargin', 'isDominantWin',
              'winStreakTeam', 'winStreakCount', 'consecutiveWinsTeam',
              'consecutiveWinsCount', 'scrambled', 'scrambleCondition', 'scrambleType'],
    owner: 'TeamBalancer',
    note: 'Opt-in TB round logging'
  }
];

// ─── Abandoned Tables ─────────────────────────────────────────────
//
// Present by design, read by nothing. Three of these were replaced by a
// table with a composite primary key when the suite learned to share one
// database between servers, and the fourth held a single row that no code
// ever looked at. None of them can be dropped by the suite: the deployed
// MySQL user has no DROP grant, and the migrations that create them are
// recorded in production, so they reappear on a fresh install too.
//
// They are reported, because an operator looking at a table list deserves
// to be told which ones are dead — and an operator who does have DROP can
// act on it. They are not warnings and not failures: a database carrying
// all four is a correct database.

const ABANDONED_TABLES = [
  { table: 'S3_PlayerReconnects', replacedBy: 'S3_ServerReconnects' },
  { table: 'S3_PlayerSessions', replacedBy: 'S3_ServerSessions' },
  { table: 'SwitchPlugin_Settings', replacedBy: 'SwitchPlugin_ServerSettings' },
  { table: 'Elo_PluginStates', replacedBy: null }
];

// ─── Deprecated/Orphan Tables Known to Be Cleaned Up ──────────────
//
// These were dropped by the SA v2 and Elo v2 migrations (7.4j).
// If they still exist, they are orphan tables.

const DEPRECATED_TABLES = [
  'SmartAssignReconnectMemory',
  'SmartAssignState',
  'SA_RoundSummary',
  'SA_PlayerEvent'
];

// S³-owned table prefix filter (for orphan detection)
const S3_PREFIXES = [
  'S3_', 'SA_', 'Elo_', 'TB_', 'SwitchPlugin_', 'TeamBalancer',
  'SmartAssign', 'SmartAssignReconnect'
];

// ─── Helpers ─────────────────────────────────────────────────────

function resolveDbPath(raw) {
  if (raw) return resolve(raw);
  // Default: resolve from project root (../../ from tools/)
  return resolve(__dirname, '..', '..', 'squad-server.sqlite');
}

function padRight(str, len) {
  return str.padEnd(len, ' ');
}

// ─── Core Logic ──────────────────────────────────────────────────

async function checkAllTables(sequelize) {
  // Get all tables in the DB
  // QueryTypes.SELECT already unwraps to a row array — it does NOT return the
  // [rows, metadata] tuple the raw query form does. Destructuring it here took
  // the first *row* instead of the row array, failed the Array.isArray check
  // below, and left allTableNames empty, so every table reported ❌ missing
  // whatever the database actually held.
  const allTablesRaw = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    { type: Sequelize.QueryTypes.SELECT }
  );

  const allTableNames = (Array.isArray(allTablesRaw) ? allTablesRaw : [])
    .map(r => r.name)
    .filter(Boolean);

  // Every name comparison below folds. SQLite stores a table under the casing
  // it was declared with, so an exact match happens to work here today — but
  // the expected list is the same list of names the suite hands to servers that
  // do not, and a check that reads a healthy table as missing (or a known table
  // as an orphan) is the failure this whole convention exists to stop. Keyed by
  // the folded name so the stored casing is still available for the PRAGMA.
  const storedByFolded = new Map(allTableNames.map(n => [n.toLowerCase(), n]));

  const results = [];
  let totalChecks = 0;
  let totalPassed = 0;
  let totalWarnings = 0;
  let totalFailed = 0;
  let totalAbandoned = 0;

  // 1. Check each expected table
  for (const expected of EXPECTED_TABLES) {
    const { table, columns, owner, note } = expected;
    totalChecks++;

    const stored = storedByFolded.get(table.toLowerCase());
    if (!stored) {
      results.push({ table, owner, note, status: '❌', detail: 'Table does not exist' });
      totalFailed++;
      continue;
    }

    // Get columns from PRAGMA
    const colResults = await sequelize.query(
      `PRAGMA table_info('${stored}')`,
      { type: Sequelize.QueryTypes.SELECT }
    );

    const actualCols = (Array.isArray(colResults) ? colResults : [])
      .map(c => c.name)
      .filter(Boolean);

    // Check for missing expected columns
    const missing = columns.filter(c => !actualCols.includes(c));
    if (missing.length > 0) {
      results.push({
        table, owner, note, status: '⚠️',
        detail: `Missing columns: ${missing.join(', ')}`
      });
      totalWarnings++;
      continue;
    }

    // Check for unexpected extra columns (informational)
    const extras = actualCols.filter(c => !columns.includes(c));
    const extraMsg = extras.length > 0 ? ` (extra cols: ${extras.join(', ')})` : '';

    results.push({
      table, owner, note, status: '✅',
      detail: `${actualCols.length} columns${extraMsg}`
    });
    totalPassed++;
  }

  // 2. Abandoned tables: reported, never counted against the database.
  const abandonedByFolded = new Map(ABANDONED_TABLES.map(a => [a.table.toLowerCase(), a]));
  for (const { table, replacedBy } of ABANDONED_TABLES) {
    const stored = storedByFolded.get(table.toLowerCase());
    if (!stored) continue; // never created, or already dropped by hand — both fine
    results.push({
      table: stored,
      owner: '—',
      note: replacedBy ? `Replaced by ${replacedBy}` : 'No longer used by any plugin',
      status: 'ℹ️',
      detail: 'Abandoned — safe to drop if your DB user has the grant'
    });
    totalAbandoned++;
  }

  // 3. Orphan detection: tables with S³ prefixes in neither list
  const expectedNames = new Set(EXPECTED_TABLES.map(t => t.table.toLowerCase()));
  const deprecatedNames = new Set(DEPRECATED_TABLES.map(t => t.toLowerCase()));

  for (const name of allTableNames) {
    const folded = name.toLowerCase();
    const isS3Managed = S3_PREFIXES.some(p => folded.startsWith(p.toLowerCase()));
    if (!isS3Managed) continue;
    if (expectedNames.has(folded)) continue;
    if (abandonedByFolded.has(folded)) continue;

    totalChecks++;
    if (deprecatedNames.has(folded)) {
      results.push({
        table: name, owner: '—', note: 'Deprecated (7.4j)',
        status: '⚠️', detail: 'Orphan — should have been dropped by migration'
      });
      totalWarnings++;
    } else {
      results.push({
        table: name, owner: '—', note: 'Unknown table',
        status: '❌', detail: 'Unexpected S³-prefixed table'
      });
      totalFailed++;
    }
  }

  return { results, totalChecks, totalPassed, totalWarnings, totalFailed, totalAbandoned };
}

// ─── Output Formatters ───────────────────────────────────────────

function formatHuman({ results, totalChecks, totalPassed, totalWarnings, totalFailed, totalAbandoned }, dbPath) {
  const lines = [];
  lines.push('');
  lines.push('═'.repeat(68));
  lines.push('  S³ Schema Health Report');
  lines.push('═'.repeat(68));
  lines.push(`  Database: ${dbPath}`);
  lines.push(`  Checked : ${new Date().toISOString()}`);
  lines.push('');

  const width = 30;

  for (const r of results) {
    lines.push(`  ${r.status} ${padRight(r.table, width)} ${r.detail}`);
    lines.push(`      Owner: ${r.owner}`);
    if (r.note) lines.push(`      Note : ${r.note}`);
    lines.push('');
  }

  lines.push('─'.repeat(68));
  lines.push(`  ${totalPassed + totalWarnings + totalFailed} tables checked`);
  lines.push(`  ✅ ${totalPassed} passed`);
  lines.push(`  ⚠️  ${totalWarnings} warnings`);
  lines.push(`  ❌ ${totalFailed} failed`);
  if (totalAbandoned > 0) {
    lines.push(`  ℹ️ ${totalAbandoned} abandoned (not a problem — see above)`);
  }

  if (totalFailed > 0) {
    lines.push('');
    lines.push('  ❗ Some checks failed. Run `node s3/tools/schema-version.mjs check`');
    lines.push('     for per-plugin version status. If this is a fresh install,');
    lines.push('     tables will be created on next S³ mount.');
  }

  lines.push('═'.repeat(68));
  lines.push('');
  return lines.join('\n');
}

function formatJson({ results, totalChecks, totalPassed, totalWarnings, totalFailed, totalAbandoned }, dbPath) {
  return JSON.stringify({
    dbPath,
    checkedAt: new Date().toISOString(),
    totalChecks,
    totalPassed,
    totalWarnings,
    totalFailed,
    totalAbandoned,
    tables: results.map(r => ({
      table: r.table,
      status: r.status === '✅' ? 'ok'
        : r.status === '⚠️' ? 'warning'
        : r.status === 'ℹ️' ? 'abandoned'
        : 'error',
      detail: r.detail,
      owner: r.owner
    }))
  }, null, 2);
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dbPathIndex = args.indexOf('--db-path');
  const dbPath = resolveDbPath(dbPathIndex >= 0 ? args[dbPathIndex + 1] : null);
  const useJson = args.includes('--json');

  if (!existsSync(dbPath)) {
    console.error(`ERROR: Database not found at "${dbPath}"`);
    console.error('  Use --db-path <path> to specify a different location.');
    process.exit(1);
  }

  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: dbPath,
    logging: false
  });

  try {
    const report = await checkAllTables(sequelize);

    if (useJson) {
      console.log(formatJson(report, dbPath));
    } else {
      console.log(formatHuman(report, dbPath));
    }

    process.exit(report.totalFailed > 0 ? 1 : 0);
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

main();