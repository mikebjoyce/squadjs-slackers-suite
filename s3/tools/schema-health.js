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
 * Twelve tables from Appendix A of stage7.4-db-schema-rework.md:
 *   S3_*       — core S³ tables (5 tables)
 *   SA_*       — SmartAssign tables (1 table: SA_AssignmentLog)
 *   Elo_*      — EloTracker tables (3 tables)
 *   TB_*       — TeamBalancer tables (2 tables)
 *   S3_SchemaVersions — version tracking
 *
 * Plus orphan detection: any table starting with SA_, Elo_, TB_, or
 * S3_ that exists in the DB but isn't in the expected list is flagged.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * sqlite3 (via better-sqlite3 or default sqlite3 package).
 * Falls back to sequelize if available.
 *
 */

const { resolve, dirname } = require('path');
const { existsSync } = require('fs');
const { Sequelize } = require('sequelize');

// ─── Expected Tables ──────────────────────────────────────────────
//
// Each entry: { table, expectedColumns[] }
// Columns listed are the ones we expect to find (subset). The checker
// verifies column names not exact types, since SQLite column types
// are advisory.

const EXPECTED_TABLES = [
  {
    table: 'S3_GameState',
    columns: ['id', 'phase', 'resolving', 'lastRoundEndedAt', 'lastStateChangeAt',
              'lastRecoveryAt', 'roundStartTime', 'matchId', 'layerName', 'gamemode',
              'layerNameEnglish', 'team1Name', 'team2Name', 'team1ShortName', 'team2ShortName',
              'team1Faction', 'team2Faction'],
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
    table: 'S3_PlayerEvents',
    columns: ['id', 'matchId', 'roundStartTime', 'ts', 'eventType', 'eosID',
              'steamID', 'name', 'teamID', 'squadID', 'oldTeamID', 'newTeamID',
              'source', 'betweenRounds', 't1', 't2'],
    owner: 'S³ core (LoggingService)',
    note: 'Cross-plugin player event stream (7.4h)'
  },
  {
    table: 'S3_GameStateEvents',
    columns: ['id', 'matchId', 'ts', 'eventType', 'oldPhase', 'newPhase',
              'resolving', 'layerName', 'gamemode'],
    owner: 'S³ core (LoggingService)',
    note: 'Phase transition event stream (7.4h)'
  },
  {
    table: 'S3_PlayerSnapshots',
    columns: ['id', 'matchId', 'ts', 'trigger', 'playersJson', 't1', 't2'],
    owner: 'S³ core (LoggingService)',
    note: 'Full roster snapshots at LIVE/MID_ROUND/ENDGAME (7.4h)'
  },
  {
    table: 'SA_AssignmentLog',
    columns: ['id', 'matchId', 'roundStartTime', 'ts', 'eventType', 'eosID',
              'steamID', 'name', 'teamID', 'squadID', 'reason', 'source',
              'sourceName', 'sourceSteamID'],
    owner: 'SmartAssign',
    note: 'SA-specific assignment decisions (7.4i)'
  },
  {
    table: 'Elo_PlayerStats',
    columns: ['eosID', 'steamID', 'discordID', 'name', 'mu', 'sigma',
              'wins', 'losses', 'roundsPlayed', 'lastSeen'],
    owner: 'EloTracker',
    note: 'Core Elo ratings'
  },
  {
    table: 'Elo_RoundHistory',
    columns: ['id', 'matchId', 'layerName', 'winningTeamID', 'ticketDiff',
              'roundDuration', 'endedAt', 'playerCount'],
    owner: 'EloTracker',
    note: 'Opt-in Elo round logging'
  },
  {
    table: 'Elo_RoundPlayers',
    columns: ['id', 'matchId', 'roundStartTime', 'roundHistoryId',
              'eosID', 'steamID', 'name', 'teamID', 'participationRatio',
              'muBefore', 'sigmaBefore', 'muAfter', 'sigmaAfter', 'muDelta', 'sigmaDelta'],
    owner: 'EloTracker',
    note: 'Opt-in per-player Elo deltas'
  },
  {
    table: 'TeamBalancerState',
    columns: ['id', 'winStreakTeam', 'winStreakCount', 'consecutiveWinsTeam',
              'consecutiveWinsCount', 'lastSyncTimestamp', 'lastScrambleTime', 'manuallyDisabled'],
    owner: 'TeamBalancer',
    note: 'Core TB state (single row)'
  },
  {
    table: 'TB_RoundReport',
    columns: ['id', 'matchId', 'roundStartTime', 'ts', 'layerName', 'gameMode',
              'playerCount', 'winningTeamID', 'winnerName', 'loserName',
              'tickets', 'margin', 'isDominantWin'],
    owner: 'TeamBalancer',
    note: 'Opt-in TB round logging'
  }
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
const S3_PREFIXES = ['S3_', 'SA_', 'Elo_', 'TB_', 'SmartAssign', 'SmartAssignReconnect'];

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
  const [allTablesRaw] = await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    { type: Sequelize.QueryTypes.SELECT }
  );

  const allTableNames = (Array.isArray(allTablesRaw) ? allTablesRaw : [])
    .map(r => r.name)
    .filter(Boolean);

  const results = [];
  let totalChecks = 0;
  let totalPassed = 0;
  let totalWarnings = 0;
  let totalFailed = 0;

  // 1. Check each expected table
  for (const expected of EXPECTED_TABLES) {
    const { table, columns, owner, note } = expected;
    totalChecks++;

    const exists = allTableNames.includes(table);
    if (!exists) {
      results.push({ table, owner, note, status: '❌', detail: 'Table does not exist' });
      totalFailed++;
      continue;
    }

    // Get columns from PRAGMA
    const [colResults] = await sequelize.query(
      `PRAGMA table_info('${table}')`,
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

  // 2. Orphan detection: tables with S³ prefixes not in expected list and not deprecated
  const expectedNames = new Set(EXPECTED_TABLES.map(t => t.table));
  const deprecatedNames = new Set(DEPRECATED_TABLES);

  for (const name of allTableNames) {
    const isS3Managed = S3_PREFIXES.some(p => name.startsWith(p));
    if (!isS3Managed) continue;
    if (expectedNames.has(name)) continue;

    totalChecks++;
    if (deprecatedNames.has(name)) {
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

  return { results, totalChecks, totalPassed, totalWarnings, totalFailed };
}

// ─── Output Formatters ───────────────────────────────────────────

function formatHuman({ results, totalChecks, totalPassed, totalWarnings, totalFailed }, dbPath) {
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

  if (totalFailed > 0) {
    lines.push('');
    lines.push('  ❗ Some checks failed. Run `node build/schema-version.cjs check`');
    lines.push('     for per-plugin version status. If this is a fresh install,');
    lines.push('     tables will be created on next S³ mount.');
  }

  lines.push('═'.repeat(68));
  lines.push('');
  return lines.join('\n');
}

function formatJson({ results, totalChecks, totalPassed, totalWarnings, totalFailed }, dbPath) {
  return JSON.stringify({
    dbPath,
    checkedAt: new Date().toISOString(),
    totalChecks,
    totalPassed,
    totalWarnings,
    totalFailed,
    tables: results.map(r => ({
      table: r.table,
      status: r.status === '✅' ? 'ok' : r.status === '⚠️' ? 'warning' : 'error',
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