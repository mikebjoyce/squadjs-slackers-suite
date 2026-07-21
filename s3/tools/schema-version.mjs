/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           SCHEMA VERSION CLI                                 ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Offline CLI tool for schema version management. Uses the same
 * DBService + MigrationEngine infrastructure the live S³ plugin
 * does, but runs standalone at the command line. Enables schema
 * checks, migration previews, and migration execution when the
 * SquadJS server is offline (Discord unavailable).
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node tools/schema-version.mjs check            ← version status per plugin
 *   node tools/schema-version.mjs pending          ← preview pending migrations
 *   node tools/schema-version.mjs migrate          ← apply pending migrations
 *   node tools/schema-version.mjs migrate --dry-run ← preview without writing
 *   node tools/schema-version.mjs migrate --force   ← skip confirm prompt
 *   node tools/schema-version.mjs migrate --plugin smart-assign  ← single plugin
 *   node tools/schema-version.mjs check --db-path ./custom.sqlite
 *
 * ─── MIGRATION MANIFEST ──────────────────────────────────────────
 *
 * Mirrors the runtime registrations in each plugin. This is the
 * single source of truth for offline migrations. If a new plugin
 * registers migrations at runtime, add its manifest here too.
 *
 *   Plugin        | Expected Version | Migration(s)     | Source
 *   --------------|-----------------|------------------|-----------------------
 *   s3-core       | 0               | (none)           | S³ DBService
 *   smart-assign  | 2               | v1→v2 (SA v2)   | smart-assign.js
 *   elo-tracker   | 2               | v1→v2 (Elo v2)  | elo-tracker.js
 *   team-balancer | 1               | (none)           | team-balancer.js
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 *   ../utils/db-service.js      — DBService class
 *   ../utils/migration-engine.js — MigrationEngine class
 *   ../../build/config.json     — DB path configuration
 *   Node.js >= 16 (ESM support)
 *
 */

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Sequelize } from 'sequelize';

import DBService from '../utils/db-service.js';
import MigrationEngine from '../utils/migration-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Migration Manifest ───────────────────────────────────────────
//
// Each entry declares:
//   pluginName   - Unique identifier (matches runtime registerExpectedVersion)
//   expectedVersion - Target schema version for this plugin
//   migrations   - Array of migration objects passed to MigrationEngine
//
// This mirrors the runtime registrations in:
//   ReferenceScripts/squadjs-smart-assign/plugins/smart-assign.js
//   ReferenceScripts/squadjs-elo-tracker/plugins/elo-tracker.js

const MIGRATION_MANIFEST = [
  {
    pluginName: 's3-core',
    expectedVersion: 0,
    migrations: []
  },
  {
    pluginName: 'smart-assign',
    expectedVersion: 2,
    migrations: [
      {
        version: 2,
        description: 'SA v2: Drop 4 orphan tables (SmartAssignReconnectMemory, SmartAssignState, SA_RoundSummary, SA_PlayerEvent)',
        up: async (qi) => {
          await qi.dropTable('SmartAssignReconnectMemory');
          await qi.dropTable('SmartAssignState');
          await qi.dropTable('SA_RoundSummary');
          await qi.dropTable('SA_PlayerEvent');
        },
        down: async (qi) => {
          // Recreate minimal schemas for rollback safety
          await qi.createTable('SmartAssignState', {
            id: { type: 'INTEGER', primaryKey: true },
            roundStartTime: { type: 'BIGINT', allowNull: true }
          });
          await qi.createTable('SmartAssignReconnectMemory', {
            steamID: { type: 'STRING', primaryKey: true },
            teamID: { type: 'INTEGER' },
            disconnectTime: { type: 'BIGINT' }
          });
          await qi.createTable('SA_RoundSummary', {
            id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
            matchId: { type: 'STRING', allowNull: true }
          });
          await qi.createTable('SA_PlayerEvent', {
            id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
            matchId: { type: 'STRING', allowNull: true }
          });
        }
      }
    ]
  },
  {
    pluginName: 'elo-tracker',
    expectedVersion: 2,
    migrations: [
      {
        version: 2,
        description: 'Elo v2: Drop vestigial roundStartTime column from Elo_PluginState',
        up: async (qi) => {
          await qi.removeColumn('Elo_PluginState', 'roundStartTime');
        },
        down: async (qi) => {
          await qi.addColumn('Elo_PluginState', 'roundStartTime', {
            type: 'BIGINT',
            allowNull: true
          });
        }
      }
    ]
  },
  {
    pluginName: 'team-balancer',
    expectedVersion: 1,
    migrations: []
  }
];

// ─── Helpers ─────────────────────────────────────────────────────

function resolveDbPath(raw) {
  if (raw) return resolve(raw);

  // Try to read from build/config.json first
  const configPath = resolve(__dirname, '..', '..', 'build', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const storage = config?.connectors?.sqlite?.storage;
      if (storage) {
        // storage is relative to the config.json, which is in build/, so resolve relative to there
        return resolve(dirname(configPath), storage);
      }
    } catch {
      // Fall through to default
    }
  }

  // Default: project root squad-server.sqlite
  return resolve(__dirname, '..', '..', 'squad-server.sqlite');
}

function askYesNo(query) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolvePromise) => {
    rl.question(`${query} (y/N) `, (answer) => {
      rl.close();
      resolvePromise(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

function padRight(str, len) {
  return str.padEnd(len, ' ');
}

// ─── Bootstrap ──────────────────────────────────────────────────

async function bootstrap(dbPath) {
  if (!existsSync(dbPath)) {
    console.error(`ERROR: Database not found at "${dbPath}"`);
    console.error('  Use --db-path <path> to specify a different location.');
    process.exit(1);
  }

  console.log(`  Database: ${dbPath}`);

  // Resolve Sequelize connector from the DB path
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: dbPath,
    logging: false
  });

  // Create a minimal DBService with the Sequelize instance
  const dbService = new DBService({
    sequelize,
    databaseOption: 'sqlite',
    verboseLogger: (level, msg) => {
      if (level <= 2) console.log(`  ${msg}`);
    },
    emitEvent: (eventName, data) => {
      // Silently absorb events in CLI mode
    }
  });

  // Mount DBService (creates SchemaVersion table, runs verifySchemaVersions)
  await dbService.mount();

  // Register migrations from manifest
  for (const entry of MIGRATION_MANIFEST) {
    dbService.registerExpectedVersion(entry.pluginName, entry.expectedVersion);
    if (entry.migrations.length > 0) {
      dbService.migrationEngine.registerMigrations(entry.pluginName, entry.migrations);
    }
  }

  return { dbService, sequelize };
}

// ─── Subcommands ─────────────────────────────────────────────────

/**
 * `check` — Print per-plugin version status.
 * Shows expected vs actual version for each registered plugin.
 */
async function cmdCheck({ dbService }) {
  const result = await dbService.verifySchemaVersions();

  console.log('');
  console.log('═'.repeat(62));
  console.log('  Schema Version Status');
  console.log('═'.repeat(62));
  console.log('');

  const width = 20;

  // Show all registered plugins
  for (const entry of MIGRATION_MANIFEST) {
    const pending = result.pending.find(p => p.pluginName === entry.pluginName);
    const current = pending ? pending.currentVersion : entry.expectedVersion;
    const isUpToDate = current >= entry.expectedVersion;
    const status = isUpToDate ? '✅' : '⚠️';
    const detail = isUpToDate
      ? `v${current} (current)`
      : `v${current} → v${entry.expectedVersion} (${entry.expectedVersion - current} behind)`;

    console.log(`  ${status} ${padRight(entry.pluginName, width)} ${detail}`);
  }

  console.log('');
  console.log('─'.repeat(62));
  console.log(`  ${result.upToDate ? '✅ All plugins up to date' : '⚠️ Migrations pending — run `node tools/schema-version.mjs pending` for details'}`);
  console.log('═'.repeat(62));
  console.log('');

  return result.upToDate ? 0 : 1;
}

/**
 * `pending` — Print pending migrations for each plugin.
 */
async function cmdPending({ dbService }) {
  console.log('');
  console.log('═'.repeat(62));
  console.log('  Pending Migrations');
  console.log('═'.repeat(62));
  console.log('');

  let hasPending = false;

  for (const entry of MIGRATION_MANIFEST) {
    const pending = await dbService.migrationEngine.pendingMigrations(entry.pluginName);

    if (pending.length === 0) {
      console.log(`  ✅ ${entry.pluginName} — up to date (no pending migrations)`);
      continue;
    }

    hasPending = true;
    console.log(`  ⚠️  ${entry.pluginName}:`);
    for (const m of pending) {
      const desc = m.description || '(no description)';
      console.log(`       v${m.version} — ${desc}`);
    }
    console.log('');
  }

  console.log('─'.repeat(62));
  if (hasPending) {
    console.log('  Run `node tools/schema-version.mjs migrate` to apply pending migrations.');
  } else {
    console.log('  ✅ No pending migrations.');
  }
  console.log('═'.repeat(62));
  console.log('');

  return hasPending ? 1 : 0;
}

/**
 * `migrate` — Apply pending migrations.
 * Options:
 *   --dry-run   Preview only (no writes)
 *   --force     Skip confirmation prompt
 *   --plugin <name>  Apply only for a specific plugin
 */
async function cmdMigrate({ dbService }, options) {
  const { dryRun = false, force = false, pluginFilter = null } = options;
  const pluginsToMigrate = pluginFilter
    ? MIGRATION_MANIFEST.filter(e => e.pluginName === pluginFilter)
    : MIGRATION_MANIFEST;

  if (pluginsToMigrate.length === 0) {
    console.error(`  ❌ No plugin found matching "${pluginFilter}"`);
    return 1;
  }

  console.log('');
  console.log('═'.repeat(62));
  console.log(dryRun ? '  Migration Preview (DRY RUN)' : '  Migration Run');
  console.log('═'.repeat(62));
  console.log('');

  let totalApplied = 0;
  let totalSkipped = 0;

  for (const entry of pluginsToMigrate) {
    const pending = await dbService.migrationEngine.pendingMigrations(entry.pluginName);

    if (pending.length === 0) {
      console.log(`  ✅ ${entry.pluginName} — up to date`);
      continue;
    }

    console.log(`  ${entry.pluginName} — ${pending.length} pending migration(s):`);
    for (const m of pending) {
      console.log(`       v${m.version} — ${m.description || '(no description)'}`);
    }
    console.log('');

    if (dryRun) {
      totalSkipped += pending.length;
      continue;
    }
  }

  if (dryRun) {
    console.log('─'.repeat(62));
    console.log(`  DRY RUN: ${totalSkipped} migration(s) would be applied.`);
    console.log('  Run without --dry-run to execute.');
    console.log('═'.repeat(62));
    console.log('');
    return totalSkipped > 0 ? 0 : 0; // Not an error in dry-run mode
  }

  // Check if there's anything to actually run
  let hasWork = false;
  for (const entry of pluginsToMigrate) {
    const pending = await dbService.migrationEngine.pendingMigrations(entry.pluginName);
    if (pending.length > 0) hasWork = true;
  }

  if (!hasWork) {
    console.log('  ✅ All selected plugins are up to date.');
    console.log('═'.repeat(62));
    console.log('');
    return 0;
  }

  // Confirm unless force
  if (!force) {
    const ok = await askYesNo('  Apply these migrations?');
    if (!ok) {
      console.log('  Cancelled.');
      console.log('═'.repeat(62));
      console.log('');
      return 1;
    }
  }

  // Run migrations
  for (const entry of pluginsToMigrate) {
    try {
      const result = await dbService.migrationEngine.runMigrations(entry.pluginName);
      totalApplied += result.applied;
      totalSkipped += result.skipped;

      if (result.applied > 0) {
        console.log(`  ✅ ${entry.pluginName}: ${result.applied} migration(s) applied`);
      }
      if (result.skipped > 0) {
        console.log(`  ⚠️  ${entry.pluginName}: ${result.skipped} skipped`);
      }
    } catch (err) {
      console.error(`  ❌ ${entry.pluginName}: ${err.message}`);
      return 1;
    }
  }

  console.log('');
  console.log('─'.repeat(62));
  console.log(`  ${totalApplied} migration(s) applied. ${totalSkipped} skipped.`);
  console.log('═'.repeat(62));
  console.log('');

  return 0;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || ['--help', '-h'].includes(subcommand)) {
    console.log('');
    console.log('S³ Schema Version CLI');
    console.log('');
    console.log('Usage:');
    console.log('  node tools/schema-version.mjs check            Version status per plugin');
    console.log('  node tools/schema-version.mjs pending          Preview pending migrations');
    console.log('  node tools/schema-version.mjs migrate          Apply pending migrations');
    console.log('  node tools/schema-version.mjs migrate --dry-run  Preview without writing');
    console.log('  node tools/schema-version.mjs migrate --force    Skip confirmation');
    console.log('  node tools/schema-version.mjs migrate --plugin <name>  Single plugin');
    console.log('  node tools/schema-version.mjs <cmd> --db-path <path>    Custom DB path');
    console.log('');
    process.exit(0);
  }

  if (!['check', 'pending', 'migrate'].includes(subcommand)) {
    console.error(`Unknown subcommand: "${subcommand}"`);
    console.error('Use --help for usage information.');
    process.exit(1);
  }

  // Parse shared options
  const dbPathIndex = args.indexOf('--db-path');
  const dbPath = resolveDbPath(dbPathIndex >= 0 ? args[dbPathIndex + 1] : null);

  // Parse migrate-specific options
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const pluginIndex = args.indexOf('--plugin');
  const pluginFilter = pluginIndex >= 0 ? args[pluginIndex + 1] : null;

  // Bootstrap
  const { dbService, sequelize } = await bootstrap(dbPath);

  try {
    let exitCode = 0;

    switch (subcommand) {
      case 'check':
        exitCode = await cmdCheck({ dbService });
        break;
      case 'pending':
        exitCode = await cmdPending({ dbService });
        break;
      case 'migrate':
        exitCode = await cmdMigrate({ dbService }, { dryRun, force, pluginFilter });
        break;
    }

    // Cleanup
    await dbService.unmount();
    await sequelize.close();

    process.exit(exitCode);
  } catch (err) {
    console.error('Fatal error:', err.message);
    await dbService.unmount();
    await sequelize.close();
    process.exit(1);
  }
}

main();