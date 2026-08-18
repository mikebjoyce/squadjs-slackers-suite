/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     DIALECT PORTABILITY — SQLITE / MYSQL / POSTGRES           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Regression cover for the Postgres-portability defects documented in
 * docs/TASK_POSTGRES_PORTABILITY.md. Every case here runs the SQL against a
 * REAL engine, because this whole class of defect is invisible to a mock by
 * construction: a hand-written mock cannot model Postgres identifier folding,
 * MySQL collation, or SQLite's ESCAPE parsing. The mock suite in
 * switch/testing/ passed throughout the entire lifetime of these bugs.
 *
 * SQLite always runs (in-memory, no setup). MySQL and Postgres are Docker-gated
 * and skip gracefully when unreachable — but they are where the value is, so
 * run them before trusting any change to raw SQL.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   1. DBService.quoteIdentifier / incrementLiteral   — camelCase columns in
 *      Sequelize.literal (Switch token + seed-bonus grants).
 *   2. DBService.caseInsensitiveLikeOp                — Switch checkPlayer().
 *   3. DBService.caseInsensitiveLikeLiteral           — EloTracker searchPlayer(),
 *      incl. apostrophes and literal % / _ in the search term.
 *   4. Bootstrap DDL quoting                          — S3_PlayerReconnects /
 *      S3_PlayerSessions, plus backward-compatibility with tables an older
 *      build created unquoted (the "don't break live SQLite/MySQL" guarantee).
 *   5. Foreign-key toggles                            — s3-export-import.js.
 *   6. Backup fallback                                — getDatabasePath() is null
 *      off SQLite, so the JSON export path must engage.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-dialect-portability.js
 *
 *   # with the Docker engines (ports match test-migration-permissions.js):
 *   docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres \
 *     -p 5433:5432 postgres:16-alpine
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 *
 * Category: 1 (SQLite always; MySQL/Postgres auto-skip)
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize, DataTypes, Op } from 'sequelize';

import DBService from '../utils/db-service.js';
import { exportToJSON, importFromJSON } from '../utils/s3-export-import.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(72));
  console.log('Dialect Portability Tests  (sqlite / mysql / postgres)');
  console.log('='.repeat(72));
  console.log('');

  for (const t of tests) {
    try {
      const result = await t.fn();
      if (result === SKIP) {
        console.log(`  ⚠ ${t.name} — SKIPPED (engine unreachable)`);
        skipped++;
      } else {
        console.log(`  ✓ ${t.name}`);
        passed++;
      }
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n')[0]}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(72));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${tests.length} total`);
  console.log('─'.repeat(72));

  if (failed > 0) process.exitCode = 1;
}

const SKIP = Symbol('skip');

// ---------------------------------------------------------------------------
// Connection config — ports match test-migration-permissions.js
// ---------------------------------------------------------------------------

const MYSQL = {
  dialect: 'mysql',
  host: process.env.S3_TEST_MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_MYSQL_PORT || '3307', 10),
  username: process.env.S3_TEST_MYSQL_ROOT_USER || 'root',
  password: process.env.S3_TEST_MYSQL_ROOT_PASSWORD || 'root',
  database: process.env.S3_TEST_MYSQL_DATABASE || 'mysql',
  logging: false,
  dialectOptions: { connectTimeout: 4000 }
};

const POSTGRES = {
  dialect: 'postgres',
  host: process.env.S3_TEST_PG_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_PG_PORT || '5433', 10),
  username: process.env.S3_TEST_PG_ADMIN_USER || 'postgres',
  password: process.env.S3_TEST_PG_ADMIN_PASSWORD || 'postgres',
  database: process.env.S3_TEST_PG_DATABASE || 'postgres',
  logging: false,
  dialectOptions: { connectionTimeoutMillis: 4000 }
};

const SQLITE = { dialect: 'sqlite', storage: ':memory:', logging: false };

const reachability = new Map([['sqlite', true]]);

async function probeReachability() {
  for (const [name, opts] of [['mysql', MYSQL], ['postgres', POSTGRES]]) {
    let seq;
    try {
      seq = new Sequelize(opts);
      await seq.authenticate();
      reachability.set(name, true);
      console.log(`  ${name} reachable on ${opts.host}:${opts.port}`);
    } catch {
      reachability.set(name, false);
      console.log(`  ⚠ ${name} not reachable on ${opts.host}:${opts.port} — those cases will skip`);
    } finally {
      try { await seq?.close(); } catch { /* best effort */ }
    }
  }
  console.log('');
}

const DIALECTS = [
  { name: 'sqlite', opts: SQLITE },
  { name: 'mysql', opts: MYSQL },
  { name: 'postgres', opts: POSTGRES }
];

/**
 * Open a mounted DBService against one dialect and hand it to `fn`.
 * Returns SKIP when the engine is unreachable, so the caller can report a skip
 * rather than a false pass.
 */
async function withDialect(name, fn) {
  if (!reachability.get(name)) return SKIP;
  const opts = DIALECTS.find((d) => d.name === name).opts;
  const seq = new Sequelize(opts);
  const db = new DBService({
    sequelize: seq,
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  try {
    return await fn(db, seq);
  } finally {
    try { await db.unmount(); } catch { /* best effort */ }
    try { await seq.close(); } catch { /* best effort */ }
  }
}

/** Unique-ish suffix so parallel/rerun cases never collide on a shared engine. */
const RUN_ID = `${process.pid}_${Date.now() % 100000}`;

/** Define + create the Switch-shaped cooldown table used by the grant tests. */
async function makeCooldownsTable(db, seq, label) {
  const tableName = `T_Cooldowns_${label}_${RUN_ID}`;
  const model = seq.define(tableName, {
    eosID: { type: DataTypes.STRING(64), primaryKey: true },
    playerName: { type: DataTypes.STRING(255) },
    tokenBalance: { type: DataTypes.INTEGER, defaultValue: 0 },
    seedBonusTokensEarned: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, { tableName, freezeTableName: true, timestamps: false });
  await model.sync({ force: true });
  return model;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. quoteIdentifier — the diagnostic rule itself
// ═══════════════════════════════════════════════════════════════════════════

test('quoteIdentifier: postgres uses double quotes, sqlite/mysql use backticks', async () => {
  const expected = { sqlite: '`tokenBalance`', mysql: '`tokenBalance`', postgres: '"tokenBalance"' };
  for (const { name, opts } of DIALECTS) {
    // No connection needed — quoting is a pure function of the dialect.
    const seq = new Sequelize(opts);
    const db = new DBService({ sequelize: seq });
    assert.equal(
      db.quoteIdentifier('tokenBalance'),
      expected[name],
      `${name} quoted tokenBalance incorrectly`
    );
    await seq.close().catch(() => {});
  }
});

test('getDialect() reports the real dialect, not the connector label', async () => {
  const seq = new Sequelize(SQLITE);
  // databaseOption is the connectors-map KEY from config.json. A deployment may
  // name it anything; getConnectorName() returns that label verbatim, which is
  // why dialect branching must not be built on it.
  const db = new DBService({ sequelize: seq, databaseOption: 'mainConnector' });
  assert.equal(db.getConnectorName(), 'mainConnector');
  assert.equal(db.getDialect(), 'sqlite');
  await seq.close();
});

test('incrementLiteral emits a quoted, dialect-correct expression', async () => {
  const expected = {
    sqlite: '`tokenBalance` + 1',
    mysql: '`tokenBalance` + 1',
    postgres: '"tokenBalance" + 1'
  };
  for (const { name, opts } of DIALECTS) {
    const seq = new Sequelize(opts);
    const db = new DBService({ sequelize: seq });
    assert.equal(db.incrementLiteral('tokenBalance', 1).val, expected[name]);
    // Negative amounts render as subtraction rather than `+ -1`.
    assert.equal(
      db.incrementLiteral('tokenBalance', -2).val,
      expected[name].replace('+ 1', '- 2')
    );
    await seq.close().catch(() => {});
  }
});

test('incrementLiteral rejects a non-numeric amount', async () => {
  const seq = new Sequelize(SQLITE);
  const db = new DBService({ sequelize: seq });
  assert.throws(() => db.incrementLiteral('tokenBalance', 'oops'), /finite numeric amount/);
  await seq.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The Switch token grants — real UPDATE against each engine
// ═══════════════════════════════════════════════════════════════════════════

for (const { name } of DIALECTS) {
  test(`[${name}] incrementLiteral performs an atomic camelCase increment`, async () =>
    withDialect(name, async (db, seq) => {
      const M = await makeCooldownsTable(db, seq, 'inc');
      try {
        await M.bulkCreate([
          { eosID: 'p1', playerName: 'One', tokenBalance: 1, seedBonusTokensEarned: 0 },
          { eosID: 'p2', playerName: 'Two', tokenBalance: 3, seedBonusTokensEarned: 2 }
        ]);

        // Mirrors _grantSeedBonusAtEndgame / _checkSeedBonusGrants: two
        // camelCase increments plus a plain column set, in one statement.
        const [count] = await M.update(
          {
            tokenBalance: db.incrementLiteral('tokenBalance', 1),
            seedBonusTokensEarned: db.incrementLiteral('seedBonusTokensEarned', 1),
            playerName: 'granted'
          },
          { where: { eosID: 'p1' } }
        );

        assert.equal(count, 1, 'expected exactly one row updated');
        const p1 = await M.findByPk('p1');
        assert.equal(p1.tokenBalance, 2, 'tokenBalance did not increment');
        assert.equal(p1.seedBonusTokensEarned, 1, 'seedBonusTokensEarned did not increment');
        assert.equal(p1.playerName, 'granted');

        const p2 = await M.findByPk('p2');
        assert.equal(p2.tokenBalance, 3, 'unrelated row was modified');
      } finally {
        await M.drop().catch(() => {});
      }
    }));

  test(`[${name}] an UNQUOTED literal is the defect this replaces`, async () =>
    withDialect(name, async (db, seq) => {
      const M = await makeCooldownsTable(db, seq, 'raw');
      try {
        await M.create({ eosID: 'p1', tokenBalance: 1, seedBonusTokensEarned: 0 });

        let threw = null;
        try {
          await M.update(
            { tokenBalance: Sequelize.literal('tokenBalance + 1') },
            { where: { eosID: 'p1' } }
          );
        } catch (err) {
          threw = err;
        }

        if (db.getDialect() === 'postgres') {
          // The original bug, pinned: Postgres folds the unquoted identifier to
          // `tokenbalance`, which does not exist, and the grant is lost.
          assert.ok(threw, 'expected postgres to reject the unquoted identifier');
          assert.match(String(threw.message).toLowerCase(), /tokenbalance/);
        } else {
          // Documents WHY this went unnoticed: harmless on the deployed engines.
          assert.equal(threw, null, `${name} unexpectedly rejected the unquoted form`);
          const row = await M.findByPk('p1');
          assert.equal(row.tokenBalance, 2);
        }
      } finally {
        await M.drop().catch(() => {});
      }
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Case-insensitive name lookup — Switch checkPlayer() / Elo searchPlayer()
// ═══════════════════════════════════════════════════════════════════════════

for (const { name } of DIALECTS) {
  test(`[${name}] caseInsensitiveLikeOp matches regardless of case`, async () =>
    withDialect(name, async (db, seq) => {
      const M = await makeCooldownsTable(db, seq, 'like');
      try {
        await M.bulkCreate([
          { eosID: 'a', playerName: 'SlackerBob' },
          { eosID: 'b', playerName: 'Someone Else' }
        ]);

        const likeOp = db.caseInsensitiveLikeOp();
        const rows = await M.findAll({ where: { playerName: { [likeOp]: '%slacker%' } } });

        assert.equal(rows.length, 1, 'lower-case query failed to find SlackerBob');
        assert.equal(rows[0].eosID, 'a');

        // The operator must also be the *right* one for the engine: Op.iLike is
        // a syntax error on sqlite/mysql, so an unconditional swap breaks them.
        assert.equal(
          likeOp,
          db.getDialect() === 'postgres' ? Op.iLike : Op.like,
          'wrong LIKE operator selected for this dialect'
        );
      } finally {
        await M.drop().catch(() => {});
      }
    }));

  test(`[${name}] plain Op.like is case-SENSITIVE on postgres only`, async () =>
    withDialect(name, async (db, seq) => {
      const M = await makeCooldownsTable(db, seq, 'likeraw');
      try {
        await M.create({ eosID: 'a', playerName: 'SlackerBob' });
        const rows = await M.findAll({ where: { playerName: { [Op.like]: '%slacker%' } } });
        if (db.getDialect() === 'postgres') {
          assert.equal(rows.length, 0, 'postgres LIKE unexpectedly matched case-insensitively');
        } else {
          assert.equal(rows.length, 1, `${name} LIKE should already be case-insensitive`);
        }
      } finally {
        await M.drop().catch(() => {});
      }
    }));

  test(`[${name}] caseInsensitiveLikeLiteral: case, apostrophes and literal wildcards`, async () =>
    withDialect(name, async (db, seq) => {
      const M = await makeCooldownsTable(db, seq, 'lit');
      try {
        await M.bulkCreate([
          { eosID: 'a', playerName: 'SlackerBob' },
          { eosID: 'b', playerName: "O'Brien" },
          { eosID: 'c', playerName: 'Big_Mike' },
          { eosID: 'd', playerName: 'BigXMike' },
          { eosID: 'e', playerName: '50%Off' }
        ]);

        const find = async (term) => {
          const rows = await M.findAll({ where: db.caseInsensitiveLikeLiteral('playerName', term) });
          return rows.map((r) => r.eosID).sort();
        };

        assert.deepEqual(await find('slacker'), ['a'], 'case-insensitive match failed');

        // Was a syntax error before: the term was interpolated into a quoted SQL
        // string with no escaping, and the failure was swallowed as "not found".
        assert.deepEqual(await find("o'brien"), ['b'], 'apostrophe in search term failed');

        // `_` must match itself, not "any character" — otherwise Big_Mike also
        // returns BigXMike and the caller reports an ambiguous match.
        assert.deepEqual(await find('Big_Mike'), ['c'], 'underscore was treated as a wildcard');

        // Likewise `%` must not swallow the rest of the pattern.
        assert.deepEqual(await find('50%off'), ['e'], 'percent was treated as a wildcard');

        // The escape character itself must be escapable.
        assert.deepEqual(await find('!'), [], 'bare escape char should match nothing here');
      } finally {
        await M.drop().catch(() => {});
      }
    }));

  test(`[${name}] caseInsensitiveLikeLiteral composes inside Op.or`, async () =>
    withDialect(name, async (db, seq) => {
      // EloTracker ORs the name match with a steamID equality; a literal that
      // only works as a top-level where would break that call site.
      const M = await makeCooldownsTable(db, seq, 'or');
      try {
        await M.bulkCreate([
          { eosID: 'a', playerName: 'SlackerBob' },
          { eosID: 'z', playerName: 'Nobody' }
        ]);
        const rows = await M.findAll({
          where: {
            [Op.or]: [
              { eosID: 'no-such-id' },
              db.caseInsensitiveLikeLiteral('playerName', 'SLACKER')
            ]
          }
        });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].eosID, 'a');
      } finally {
        await M.drop().catch(() => {});
      }
    }));

  test(`[${name}] the old ESCAPE '\\\\' spelling was NOT portable`, async () =>
    withDialect(name, async (db, seq) => {
      const M = await makeCooldownsTable(db, seq, 'esc');
      try {
        await M.create({ eosID: 'c', playerName: 'Big_Mike' });
        // Exactly what elo-database.js used to emit: ESCAPE with TWO backslashes.
        const twoBackslashes = String.fromCharCode(92, 92);
        let threw = null;
        try {
          await M.findAll({
            where: Sequelize.literal(
              `playerName LIKE '%Big${twoBackslashes}_Mike%' ESCAPE '${twoBackslashes}'`
            )
          });
        } catch (err) {
          threw = err;
        }
        if (db.getDialect() === 'mysql') {
          // MySQL processes backslash escapes in string literals, so it — and
          // only it — accepted the old form. Hence the bug survived review.
          assert.equal(threw, null, 'mysql should accept the two-backslash form');
        } else {
          assert.ok(
            threw,
            `${name} should reject the two-backslash ESCAPE — if this now passes, the ` +
            `portability argument for ESCAPE '!' needs revisiting`
          );
        }
      } finally {
        await M.drop().catch(() => {});
      }
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Bootstrap DDL quoting + backward compatibility
// ═══════════════════════════════════════════════════════════════════════════

for (const { name } of DIALECTS) {
  test(`[${name}] quoted bootstrap DDL is addressable by the Sequelize model`, async () =>
    withDialect(name, async (db, seq) => {
      // Mirrors reconnectsTableDDL() in players-service.js. The model declares
      // tableName with camelCase preserved and Sequelize quotes it, so the DDL
      // must quote identically or the two address different objects.
      const table = `T_Reconnects_${RUN_ID}`;
      const q = (id) => db.quoteIdentifier(id);
      await seq.query(`DROP TABLE IF EXISTS ${q(table)}`).catch(() => {});
      await seq.query(`
        CREATE TABLE IF NOT EXISTS ${q(table)} (
          ${q('eosID')} VARCHAR(64) PRIMARY KEY,
          ${q('lastTeamID')} INTEGER NULL,
          ${q('updatedAt')} BIGINT NOT NULL
        );
      `);
      const M = seq.define(table, {
        eosID: { type: DataTypes.STRING(64), primaryKey: true },
        lastTeamID: { type: DataTypes.INTEGER, allowNull: true },
        updatedAt: { type: DataTypes.BIGINT, allowNull: false }
      }, { tableName: table, freezeTableName: true, timestamps: false });

      try {
        await M.create({ eosID: 'x', lastTeamID: 1, updatedAt: Date.now() });
        assert.equal(await M.count(), 1, 'model could not see the bootstrapped table');

        // The raw prune statement must agree with the DDL too.
        await seq.query(
          `DELETE FROM ${q(table)} WHERE ${q('updatedAt')} < :cutoff`,
          { replacements: { cutoff: Date.now() + 60000 } }
        );
        assert.equal(await M.count(), 0, 'quoted raw DELETE did not match the rows');
      } finally {
        await seq.query(`DROP TABLE IF EXISTS ${q(table)}`).catch(() => {});
      }
    }));

  test(`[${name}] UNQUOTED bootstrap DDL is the defect this replaces`, async () =>
    withDialect(name, async (db, seq) => {
      const table = `T_Unquoted_${RUN_ID}`;
      const q = (id) => db.quoteIdentifier(id);
      await seq.query(`DROP TABLE IF EXISTS ${q(table)}`).catch(() => {});
      await seq.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
      await seq.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          eosID VARCHAR(64) PRIMARY KEY,
          updatedAt BIGINT NOT NULL
        );
      `);
      const M = seq.define(table, {
        eosID: { type: DataTypes.STRING(64), primaryKey: true },
        updatedAt: { type: DataTypes.BIGINT, allowNull: false }
      }, { tableName: table, freezeTableName: true, timestamps: false });

      try {
        let threw = null;
        try {
          await M.create({ eosID: 'x', updatedAt: Date.now() });
        } catch (err) {
          threw = err;
        }
        if (db.getDialect() === 'postgres') {
          // Postgres created `t_unquoted_…`; the model asks for `"T_Unquoted_…"`.
          assert.ok(threw, 'expected postgres to fail addressing the folded table');
          assert.match(String(threw.message).toLowerCase(), /does not exist|relation/);
        } else {
          assert.equal(threw, null, `${name} should tolerate the unquoted DDL`);
        }
      } finally {
        await seq.query(`DROP TABLE IF EXISTS ${q(table)}`).catch(() => {});
        await seq.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
      }
    }));

  test(`[${name}] quoted DDL is backward-compatible with a legacy unquoted table`, async () =>
    withDialect(name, async (db, seq) => {
      // THE upgrade-safety guarantee for existing SQLite and MySQL deployments:
      // an installed server already has these tables, created by the old
      // unquoted DDL. The new quoted DDL must be a no-op over them — not create
      // a second table, and not orphan the existing rows.
      const table = `T_Legacy_${RUN_ID}`;
      const q = (id) => db.quoteIdentifier(id);
      await seq.query(`DROP TABLE IF EXISTS ${q(table)}`).catch(() => {});
      await seq.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});

      try {
        // Old build.
        await seq.query(`
          CREATE TABLE IF NOT EXISTS ${table} (
            eosID VARCHAR(64) PRIMARY KEY,
            updatedAt BIGINT NOT NULL
          );
        `);
        await seq.query(`INSERT INTO ${table} (eosID, updatedAt) VALUES ('legacy1', 111)`);

        // New build's DDL runs on the next mount.
        await seq.query(`
          CREATE TABLE IF NOT EXISTS ${q(table)} (
            ${q('eosID')} VARCHAR(64) PRIMARY KEY,
            ${q('updatedAt')} BIGINT NOT NULL
          );
        `);

        const dialect = db.getDialect();
        if (dialect === 'postgres') {
          // Documented, accepted limitation: Postgres folded the legacy name to
          // lower case, so the quoted DDL genuinely IS a different table. Only
          // reachable on a Postgres deployment that ran a pre-fix build — and
          // Postgres was never a supported target, which is why this is
          // tolerated rather than migrated. See docs/TASK_POSTGRES_PORTABILITY.md.
          const [rows] = await seq.query(
            `SELECT tablename AS n FROM pg_tables WHERE schemaname='public' AND lower(tablename)=lower('${table}')`
          );
          assert.equal(rows.length, 2, 'expected the documented two-table split on postgres');
        } else {
          // SQLite and MySQL: one table, legacy row intact and reachable
          // through the newly quoted statements.
          const [rows] = await seq.query(
            dialect === 'sqlite'
              ? `SELECT name AS n FROM sqlite_master WHERE type='table' AND lower(name)=lower('${table}')`
              : `SELECT table_name AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND lower(table_name)=lower('${table}')`
          );
          assert.equal(rows.length, 1, 'quoted DDL created a duplicate table — upgrade would lose data');

          const [before] = await seq.query(`SELECT COUNT(*) AS c FROM ${q(table)}`);
          assert.equal(Number(before[0].c), 1, 'legacy row not visible through the quoted name');

          await seq.query(
            `DELETE FROM ${q(table)} WHERE ${q('updatedAt')} < :cutoff`,
            { replacements: { cutoff: 999 } }
          );
          const [after] = await seq.query(`SELECT COUNT(*) AS c FROM ${q(table)}`);
          assert.equal(Number(after[0].c), 0, 'quoted DELETE did not match the legacy row');
        }
      } finally {
        await seq.query(`DROP TABLE IF EXISTS ${q(table)}`).catch(() => {});
        await seq.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
      }
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Foreign-key toggles used by the JSON import path
// ═══════════════════════════════════════════════════════════════════════════

for (const { name } of DIALECTS) {
  test(`[${name}] the FK statement s3-export-import issues is valid here`, async () =>
    withDialect(name, async (db, seq) => {
      const dialect = db.getDialect();
      if (dialect === 'postgres') {
        await seq.query('SET session_replication_role = replica');
        await seq.query('SET session_replication_role = DEFAULT');
        // Fallback for non-superuser connections must also be valid.
        await seq.query('SET CONSTRAINTS ALL DEFERRED');
        await seq.query('SET CONSTRAINTS ALL IMMEDIATE');
      } else if (dialect === 'mysql') {
        await seq.query('SET FOREIGN_KEY_CHECKS = 0');
        await seq.query('SET FOREIGN_KEY_CHECKS = 1');
      }
      // SQLite: no statement is issued at all, so there is nothing to validate.
    }));

  test(`[${name}] the transposed FK statement is rejected (regression pin)`, async () =>
    withDialect(name, async (db, seq) => {
      const dialect = db.getDialect();
      if (dialect === 'mysql') {
        // The bug: a Postgres setting was being sent to MySQL, aborting restores.
        await assert.rejects(
          () => seq.query('SET session_replication_role = replica'),
          /session_replication_role/i
        );
      } else if (dialect === 'postgres') {
        await assert.rejects(
          () => seq.query('SET FOREIGN_KEY_CHECKS = 0'),
          /foreign_key_checks/i
        );
      }
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Backup fallback off SQLite  (task doc §3, previously unverified)
// ═══════════════════════════════════════════════════════════════════════════

for (const { name } of DIALECTS) {
  test(`[${name}] getDatabasePath() is SQLite-only, so JSON export must carry backup`, async () =>
    withDialect(name, async (db, seq) => {
      // getDatabasePath() reads `storage` off the connectors map, which only
      // SQLite has. MigrationEngine treats null as "no file-copy tier" and
      // relies on the JSON export instead; if that did not work, non-SQLite
      // migrations would run with no backup at all.
      assert.equal(db.getDatabasePath(), null, 'no connectors map was supplied, so this must be null');

      const table = `T_Backup_${RUN_ID}`;
      const model = db.defineModel(table, {
        eosID: { type: DataTypes.STRING(64), primaryKey: true },
        tokenBalance: { type: DataTypes.INTEGER, defaultValue: 0 }
      }, { tableName: table, freezeTableName: true, timestamps: false });
      await model.sync({ force: true });

      try {
        await model.bulkCreate([
          { eosID: 'e1', tokenBalance: 4 },
          { eosID: 'e2', tokenBalance: 7 }
        ]);

        const json = await exportToJSON(db, { tier: 'all' });
        assert.ok(json.tables[table], 'export omitted the table');
        assert.equal(json.tables[table].length, 2, 'export did not capture both rows');

        // Round-trip: wipe and restore through the same fallback path, which is
        // what exercises the FK toggles fixed above.
        await model.destroy({ where: {} });
        assert.equal(await model.count(), 0);

        const result = await importFromJSON(db, json);
        assert.equal(result.imported[table].status, 'ok', `import failed: ${result.imported[table]?.error}`);
        assert.equal(await model.count(), 2, 'restore did not bring the rows back');
        const restored = await model.findByPk('e2');
        assert.equal(restored.tokenBalance, 7, 'restored value is wrong');
      } finally {
        await model.drop().catch(() => {});
      }
    }));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await probeReachability();
await run();
