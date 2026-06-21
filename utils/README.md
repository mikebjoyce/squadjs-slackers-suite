# SlackersSquadServices Utilities

This folder is reserved for shared utility modules used by the base plugin and service modules.

## Implemented Stage 1 modules

- `game-state-service.js`
- `factions-service.js`
- `clans-service.js`
- `db-service.js`
- `players-service.js`

## DB service usage snippet (shared retry/jitter with your own connector)

```js
import DBService from './db-service.js';

// Example: consumer plugin passes its own resolved sequelize connector
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

Notes:

- SQLite connectors get a per-connector promise-chain mutex and WAL PRAGMA bootstrap once.
- Non-SQLite connectors still get retry+jitter behavior, but no mutex serialization.
- Migration tracking is provided via `S3_Migrations` + `registerMigration()` / `runMigrations()`.
