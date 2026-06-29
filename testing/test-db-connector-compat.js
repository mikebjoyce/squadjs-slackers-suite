/**
 * S³ DB CONNECTOR COMPAT TEST
 * Usage: node SlackersSquadServices/testing/test-db-connector-compat.js
 */
import assert from 'node:assert/strict';
import DBService from '../utils/db-service.js';
import { Sequelize, DataTypes } from 'sequelize';

async function runTest(name, fn) {
  try { await fn(); console.log('\u2705 ' + name); }
  catch (err) { console.error('\u274c ' + name); console.error(err); process.exitCode = 1; }
}

async function main() {
  await runTest('DBService mount with SQLite succeeds', async () => {
    const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
    await seq.authenticate();
    const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 } });
    await db.mount();
    assert.ok(db.isReady());
  });

  await runTest('getModelNames returns array after mount', async () => {
    const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
    await seq.authenticate();
    const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 } });
    await db.mount();
    const names = db.getModelNames();
    assert.ok(Array.isArray(names));
  });
}

await main();
if (!process.exitCode) console.log('\nAll connector compat tests passed.');