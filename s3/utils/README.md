# SlackersSquadServices Utilities

This directory contains the six shared service modules that make up the S³ service container. They are constructed and mounted in dependency order by `SlackersSquadServices/plugins/slackers-squad-services.js`.

## Service Catalog

| Service | File | Purpose |
|---------|------|---------|
| `db` | `db-service.js` | Centralised Sequelize operations with retry, jitter, and SQLite mutex |
| `gameState` | `game-state-service.js` | Round phase tracking, layer/gamemode resolution, crash recovery |
| `factions` | `factions-service.js` | Team/faction abbreviation discovery (TB + Switch parity) |
| `clans` | `clans-service.js` | Clan tag extraction, normalisation, caching, and team-assignment helpers |
| `players` | `players-service.js` | Player registry with move attribution and priority-based locking |
| `serverConfig` | `server-config-service.js` | Squad server config parsing and value caching |

## Mount Order

The services are built and mounted in the following order, which respects inter-service dependencies:

```
serverConfig → db → gameState → factions → clans → players
```

Each service has an `isReady()` method returning a boolean. Consumer code should gate access with `isReady()` after obtaining a reference via the flat getters (e.g. `this._s3?.gameState`).

## Inter-Service Access

Services can reference sibling services via `this.parent` (the S³ plugin instance). For example, `gameState` accesses `this.parent?.db` for DB persistence and `this.parent?.serverConfig` for vote-duration timers. Since flat getters are available on the S³ plugin, the full access pattern is `this.parent?.gameState`, `this.parent?.db`, etc.

## Retry / Jitter / SQLite Mutex

The DB service provides shared utilities usable by consumer plugins directly. **Important:** In a post-Stage-5 installation, consumer plugins should access the S³-managed `DBService` instance via `this._s3?.db` rather than constructing their own. The standalone pattern below is only needed when embedding DBService outside the S³ container (e.g. in a standalone script that doesn't mount S³).

```js
import DBService from './db-service.js';

// Consumer plugin (standalone — not wired to S³):
const db = new DBService({
  sequelize: this.options.database,
  connectors: this.connectors,
  databaseOption: this.options.database,
  verboseLogger: (...args) => this.verbose(...args),
  defaultRetry: {
    attempts: 5,
    baseDelayMs: 200,
    jitterMs: 500
  }
});

await db.mount();

// Shared retry + jitter + sqlite mutex (if sqlite dialect)
const rows = await db.executeWithRetry(async () => {
  return this.options.database.query('SELECT 1;');
});

// Shared transaction wrapper
await db.withTransactionWithRetry(async (transaction) => {
  await SomeModel.upsert({ id: 1, value: 'ok' }, { transaction });
});

await db.unmount();
```

## Notes

- SQLite connectors get a per-connector promise-chain mutex and WAL PRAGMA bootstrap once.
- Non-SQLite connectors still get retry+jitter behavior, but no mutex serialization.
- Migration tracking is provided via `S3_Migrations` + `registerMigration()` / `runMigrations()`.
- Version numbering is shared with the S³ plugin (currently v1.0.0).