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
 * ─── WHERE THE MIGRATIONS COME FROM ──────────────────────────────
 *
 * From the plugins themselves, every run. This file holds no list of
 * plugin versions and no copies of their migrations, because it used
 * to and that is exactly what broke it: the copy was maintained by
 * hand, drifted four versions behind across three plugins, lost three
 * plugins entirely, and carried a `smart-assign` v2 that did something
 * different from the real v2 under the same version number. Running
 * `migrate` against that would have recorded v2 as applied while the
 * real v2 had never run — silent, permanent, and exactly the failure
 * the version record exists to prevent.
 *
 * So the adapters below drive each plugin's real registration path and
 * read back what it registered. A plugin that changes its version, adds
 * a migration or gains a `touches` declaration is picked up with no
 * edit here. A plugin this file does not know about is reported as
 * unregistered rather than silently skipped — see `assertRegistered`.
 *
 * ─── LAYOUT ──────────────────────────────────────────────────────
 *
 * Runs in both layouts, because it has to:
 *
 *   deployed  squad-server/tools/schema-version.mjs, with the flattened
 *             plugins and utils as siblings — this is where an operator
 *             actually runs it, and imports resolve directly
 *   source    s3/tools/schema-version.mjs, where consumer plugins import
 *             sibling S³ files that only exist once flattened, so a
 *             throwaway assembly is built first and removed after
 *
 * ─── LIMITS ──────────────────────────────────────────────────────
 *
 * SQLite only. The dialect is fixed at the connection below, so a
 * community on MySQL or Postgres migrates through `!s3 migrate` rather
 * than through this tool.
 *
 * `check` and `pending` are read-only about *plugin* schema, but they
 * are not read-only about the database: mounting DBService bootstraps
 * the two S³ core tables (`S3_Locks`, `S3_Servers`) unconditionally,
 * because the lock table is what every other migration serialises on.
 * On a database that has never run multi-server S³ this creates them
 * and records `s3-core` v1. The tool says so before it connects.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 *   ../utils/db-service.js       — DBService class
 *   ../utils/migration-engine.js — MigrationEngine class
 *   ../utils/players-service.js, game-state-service.js, logging-service.js
 *   the four consumer plugins + db-log, via the layout above
 *   ../../build/config.json      — DB path configuration
 *   Node.js >= 16 (ESM support)
 *
 */

import { resolve, dirname, join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { Sequelize } from 'sequelize';

import DBService from '../utils/db-service.js';
import PlayersService from '../utils/players-service.js';
import GameStateService from '../utils/game-state-service.js';
import LoggingService from '../utils/logging-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Layout ──────────────────────────────────────────────────────

/** True when running from a flattened install (plugins are siblings). */
const DEPLOYED = existsSync(resolve(__dirname, '..', 'plugins', 'elo-tracker.js'));

/** Repo-relative assembly directory, used only in source layout. */
const ASSEMBLY_NAME = '.tmp-schema-version-cli';

/**
 * Import the plugin classes and SwitchDB, from wherever they actually are.
 *
 * In the deployed layout everything is a sibling and this is four imports.
 * In the source tree the consumer plugins import `./s3-plugin-base.js`,
 * which only resolves once install.cjs has flattened them, so a throwaway
 * assembly is built and torn down around the run.
 *
 * @returns {Promise<{modules: object, cleanup: function}>}
 */
async function loadPluginModules() {
  if (DEPLOYED) {
    const here = (f) => pathToFileURL(resolve(__dirname, '..', f)).href;
    const [elo, sa, tb, dbl, switchDb] = await Promise.all([
      import(here('plugins/elo-tracker.js')),
      import(here('plugins/smart-assign.js')),
      import(here('plugins/team-balancer.js')),
      import(here('plugins/db-log.js')),
      import(here('utils/switch-db.js'))
    ]);
    return {
      modules: {
        EloTracker: elo.default, SmartAssign: sa.default,
        TeamBalancer: tb.default, DBLog: dbl.default, SwitchDB: switchDb.default
      },
      cleanup: () => {}
    };
  }

  const { buildAssembly, importFromAssembly, cleanAssembly } =
    await import('../testing/plugin-assembly.js');

  const dir = buildAssembly(ASSEMBLY_NAME);
  try {
    const [EloTracker, SmartAssign, TeamBalancer, DBLog] = await Promise.all([
      importFromAssembly(dir, 'elo-tracker.js'),
      importFromAssembly(dir, 'smart-assign.js'),
      importFromAssembly(dir, 'team-balancer.js'),
      importFromAssembly(dir, 'db-log.js')
    ]);
    const switchDb = await import(pathToFileURL(join(dir, 'utils', 'switch-db.js')).href);
    return {
      modules: { EloTracker, SmartAssign, TeamBalancer, DBLog, SwitchDB: switchDb.default },
      // Leaving a stray assembly in the repo root is not cosmetic: a flattened
      // copy sitting there is picked up by the locale tooling and fakes a
      // tier flip, so this runs even when the command failed.
      cleanup: () => { try { cleanAssembly(dir); } catch { rmSync(dir, { recursive: true, force: true }); } }
    };
  } catch (err) {
    try { cleanAssembly(dir); } catch { rmSync(dir, { recursive: true, force: true }); }
    throw err;
  }
}

// ─── Registration probes ─────────────────────────────────────────

/**
 * A minimal stand-in for a mounted plugin, exposing only the surface the
 * schema-registration code touches. Delegates to the real DBService so the
 * models and migrations registered are the production ones.
 */
function schemaProbe(db) {
  return {
    _s3db: db,
    s3db: db,
    verbose: () => {},
    verboseLogger: () => {},
    defineModel: (name, schema, opts) => db.defineModel(name, schema, opts),
    registerExpectedVersion: (name, version, opts) => db.registerExpectedVersion(name, version, opts),
    registerMigrations: (name, migrations) => db.migrationEngine.registerMigrations(name, migrations),
    // The CLI decides when migrations run, per subcommand — never at registration.
    verifyAndRunMigrations: async () => null,
    _getModel: (name) => db.getModel(name),
    _withDb: async (fn) => fn(),
    reportError: () => {}
  };
}

/**
 * Drop the fields S3PluginBase exposes as getters.
 *
 * A probe built over a plugin prototype inherits those getters, and assigning
 * through one throws. `s3db` already derives from `_s3db`, so removing it
 * loses nothing.
 */
function stripGetters(probe) {
  const { s3db, ...rest } = probe;
  return rest;
}

/** Sentinel thrown to stop a plugin's mount once registration has happened. */
const STOP_AFTER_REGISTRATION = new Error('__stop_after_registration__');

/** Config defaults straight from the plugin's own optionsSpecification. */
function defaultOptions(PluginClass) {
  const spec = PluginClass.optionsSpecification || {};
  const options = {};
  for (const [key, def] of Object.entries(spec)) options[key] = def?.default;
  return options;
}

/**
 * Drive a plugin's real mount far enough to register its schema, then abort.
 *
 * EloTracker, SmartAssign and TeamBalancer register models and migrations
 * inline in mount()/_onS3Ready(), so unlike Switch there is no isolated
 * registration function to call. Rather than refactor three live plugins to
 * suit this tool, run the real method against a prototype-backed stand-in and
 * throw a sentinel from verifyAndRunMigrations() — the call every one of them
 * makes immediately after registering — which unwinds before any listener,
 * timer, or RCON work can start.
 *
 * If a plugin ever moves registration after that call this registers nothing,
 * and assertRegistered() below turns that into a loud failure rather than a
 * plugin quietly missing from the report.
 */
async function mountUntilRegistered(PluginClass, db, extras = {}) {
  const plugin = Object.create(PluginClass.prototype);

  Object.assign(plugin, {
    _s3db: db,
    _s3: { isReady: () => true, db },
    options: defaultOptions(PluginClass),
    server: { on: () => {}, off: () => {}, removeListener: () => {}, plugins: [] },
    _isMounted: false,
    ready: false,
    verbose: () => {},
    verboseLogger: () => {},
    reportError: () => {},
    // Version gates and option validation are not what this tool reads, and
    // both would need a fuller fake server than registration itself does.
    _checkS3Version: () => {},
    validateOptions: () => {},
    verifyAndRunMigrations: async () => { throw STOP_AFTER_REGISTRATION; },
    ...extras
  });

  const entry = typeof plugin._onS3Ready === 'function' ? '_onS3Ready' : 'mount';
  try {
    await PluginClass.prototype[entry].call(plugin);
  } catch {
    // Everything after registration is out of scope, and how it stops varies:
    // Elo and TeamBalancer let the sentinel unwind, while SmartAssign wraps its
    // registration in a catch-all and carries on until it trips over a
    // collaborator this probe does not provide. Either way the schema is
    // already registered, and assertRegistered() proves it was.
  }
}

/** The plugins this tool knows how to make register, and how. */
function buildAdapters({ EloTracker, SmartAssign, TeamBalancer, DBLog, SwitchDB }) {
  return [
    { pluginName: 'switch', register: (db) => SwitchDB.register(schemaProbe(db)) },
    { pluginName: 'elo-tracker', register: (db) => mountUntilRegistered(EloTracker, db) },
    {
      pluginName: 'smart-assign',
      // SA hands its executor an S³ reference on the way to registration.
      register: (db) => mountUntilRegistered(SmartAssign, db, { executor: {}, db: { setS3Db: () => {} } })
    },
    { pluginName: 'team-balancer', register: (db) => mountUntilRegistered(TeamBalancer, db) },
    {
      pluginName: 'db-log',
      // db-log keeps registration in its own method, so there is no mount to
      // unwind. Models are defined first because the migration's expected-model
      // list is checked against defined models during drift detection.
      register: async (db) => {
        const probe = Object.assign(Object.create(DBLog.prototype), stripGetters(schemaProbe(db)));
        await DBLog.prototype._defineModels.call(probe);
        await DBLog.prototype._registerMigrations.call(probe);
      }
    },
    {
      pluginName: 's3-players',
      // PlayersService registers BOTH its migrations inside
      // _initReconnectPersistence(), but defines the v2 table's model in
      // _initSessionPersistence(). Both are called, in mount order, because an
      // adapter that registers a migration without the model it creates is not
      // the plugin.
      register: async (db) => {
        const probe = { reconnectPersistence: true, _getDbService: () => db, verbose: () => {}, verboseLogger: () => {} };
        await PlayersService.prototype._initReconnectPersistence.call(probe);
        await PlayersService.prototype._initSessionPersistence.call(probe);
      }
    },
    {
      pluginName: 's3-gamestate',
      // Object.create over the prototype rather than a plain object literal,
      // because _initPersistence() reaches _getDbService()/_getSequelize()/
      // _getDataTypes() on the prototype.
      register: async (db) => {
        const probe = Object.create(GameStateService.prototype);
        probe.parent = { db };
        await GameStateService.prototype._initPersistence.call(probe);
      }
    },
    {
      pluginName: 's3-logging',
      register: async (db) => {
        const probe = Object.create(LoggingService.prototype);
        probe.dbService = db;
        probe.verboseLogger = () => {};
        probe.enableFileLogging = false;
        await LoggingService.prototype._initModels.call(probe);
      }
    }
  ];
}

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

/**
 * Fail loudly when an adapter ran but registered nothing.
 *
 * This is the check that replaces the old hand-written manifest's only real
 * virtue — that it always listed every plugin. An adapter whose plugin moved
 * its registration would otherwise leave that plugin silently absent from
 * `check`, which reads as "up to date".
 */
function assertRegistered(dbService, adapters) {
  const missing = adapters
    .map((a) => a.pluginName)
    .filter((name) => !dbService._expectedVersions.has(name));

  if (missing.length) {
    throw new Error(
      `Registration produced nothing for: ${missing.join(', ')}.\n` +
      '  The plugin(s) likely moved registration, so this tool cannot see their\n' +
      '  migrations and would under-report. Migrate through `!s3 migrate` instead,\n' +
      '  and fix the adapter in tools/schema-version.mjs.'
    );
  }
}

// ─── Bootstrap ──────────────────────────────────────────────────

async function bootstrap(dbPath) {
  if (!existsSync(dbPath)) {
    console.error(`ERROR: Database not found at "${dbPath}"`);
    console.error('  Use --db-path <path> to specify a different location.');
    process.exit(1);
  }

  console.log(`  Database: ${dbPath}`);
  console.log('  Note: mounting creates the S³ core tables (S3_Locks, S3_Servers)');
  console.log('        if they are absent. That happens on check and pending too.');
  if (!DEPLOYED) console.log('  Source layout: building a temporary plugin assembly...');

  const { modules, cleanup } = await loadPluginModules();

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
    emitEvent: () => {
      // Silently absorb events in CLI mode
    }
  });

  // Mount DBService (creates SchemaVersion table, registers s3-core, runs
  // verifySchemaVersions)
  await dbService.mount();

  // Harvest every other plugin's registrations from the plugins themselves.
  //
  // One try/finally around the whole harvest rather than one per adapter: an
  // earlier version cleaned up on a failing adapter but not on a failing
  // assertRegistered(), which stranded the assembly in the repo root exactly
  // when something had already gone wrong.
  const adapters = buildAdapters(modules);
  try {
    for (const adapter of adapters) {
      try {
        await adapter.register(dbService);
      } catch (err) {
        throw new Error(`Registering "${adapter.pluginName}" failed: ${err.message}`);
      }
    }
    assertRegistered(dbService, adapters);
  } catch (err) {
    cleanup();
    throw err;
  }

  // s3-core registers itself during mount(), so it belongs in the report even
  // though no adapter produced it.
  const plugins = [...dbService._expectedVersions.entries()]
    .map(([pluginName, expectedVersion]) => ({ pluginName, expectedVersion }))
    .sort((a, b) => a.pluginName.localeCompare(b.pluginName));

  return { dbService, sequelize, plugins, cleanup };
}

// ─── Subcommands ─────────────────────────────────────────────────

/**
 * `check` — Print per-plugin version status.
 * Shows expected vs actual version for each registered plugin.
 */
async function cmdCheck({ dbService, plugins }) {
  const result = await dbService.verifySchemaVersions();

  console.log('');
  console.log('═'.repeat(62));
  console.log('  Schema Version Status');
  console.log('═'.repeat(62));
  console.log('');

  const width = 20;

  for (const entry of plugins) {
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
async function cmdPending({ dbService, plugins }) {
  console.log('');
  console.log('═'.repeat(62));
  console.log('  Pending Migrations');
  console.log('═'.repeat(62));
  console.log('');

  let hasPending = false;

  for (const entry of plugins) {
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
async function cmdMigrate({ dbService, plugins }, options) {
  const { dryRun = false, force = false, pluginFilter = null } = options;
  const pluginsToMigrate = pluginFilter
    ? plugins.filter(e => e.pluginName === pluginFilter)
    : plugins;

  if (pluginsToMigrate.length === 0) {
    console.error(`  ❌ No plugin found matching "${pluginFilter}"`);
    console.error(`     Known: ${plugins.map(p => p.pluginName).join(', ')}`);
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
    return 0;
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

  // The engine gates on its own confirmation, not on this CLI's prompt. Reaching
  // here means the operator confirmed at the terminal (or passed --force), which
  // is the same authorization !s3 migrate force carries in Discord — so hand the
  // engine the same token rather than leaving migrate unable to migrate.
  dbService.migrationEngine.confirmToken('__force__');

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
    console.log('SQLite only. On MySQL or Postgres, migrate through `!s3 migrate`.');
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
  let ctx;
  try {
    ctx = await bootstrap(dbPath);
  } catch (err) {
    console.error('');
    console.error(`Fatal error during registration: ${err.message}`);
    process.exit(1);
  }

  const { dbService, sequelize, plugins, cleanup } = ctx;

  try {
    let exitCode = 0;

    switch (subcommand) {
      case 'check':
        exitCode = await cmdCheck({ dbService, plugins });
        break;
      case 'pending':
        exitCode = await cmdPending({ dbService, plugins });
        break;
      case 'migrate':
        exitCode = await cmdMigrate({ dbService, plugins }, { dryRun, force, pluginFilter });
        break;
    }

    await dbService.unmount();
    await sequelize.close();
    cleanup();

    process.exit(exitCode);
  } catch (err) {
    console.error('Fatal error:', err.message);
    try { await dbService.unmount(); } catch { /* best effort */ }
    try { await sequelize.close(); } catch { /* best effort */ }
    cleanup();
    process.exit(1);
  }
}

main();
