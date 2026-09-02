/**
 * S³ COMMANDS TEST - Unit tests for exported command handlers.
 * Usage: node SlackersSquadServices/testing/test-s3-commands.js
 */
import assert from 'node:assert/strict';
import DBService from '../utils/db-service.js';
import { Sequelize, DataTypes } from 'sequelize';
import { localize as lookupMessage } from '../utils/s3-i18n.js';

let cmds;

async function init() {
  cmds = await import('../utils/s3-commands.js');
}

async function runTest(name, fn) {
  try { await fn(); console.log('\u2705 ' + name); }
  catch (err) { console.error('\u274c ' + name); console.error(err); process.exitCode = 1; }
}

function mockMessage(overrides = {}) {
  return {
    author: { id: '123', toString: () => '<@123>' },
    channel: { send: async (msg) => msg },
    guild: { id: 'guild1' },
    member: { displayName: 'Tester' },
    client: { user: { id: 'bot1' } },
    ...overrides
  };
}

function mockS3(overrides = {}) {
  return {
    verbose: (...args) => {},
    isReady: () => true,
    s3: {
      db: { isReady: () => true, models: {}, getModelNames: () => [], getModel: () => null },
      gameState: { getPhase: () => 'inPlay', getCurrentLayer: () => 'Test_Layer', getRoundStartTime: () => Date.now(), getMatchId: () => 'match-1' },
      players: { getPlayerCount: () => 5 },
      serverConfig: { getConfig: () => ({}) },
      factions: { getEnabledFactions: () => [] },
      clans: { getClans: () => [] }
    },
    ...overrides
  };
}

async function main() {
  await init();

  // Note: s3-commands.js exports command handler functions.
  // We test each by invoking with a mock message and checking behavior.

  await runTest('status command produces embed', async () => {
    if (typeof cmds.handleStatusCommand === 'function') {
      const msg = mockMessage();
      const result = await cmds.handleStatusCommand(mockS3(), msg);
      assert.ok(result);
    } else {
      console.log('\u23f3 handleStatusCommand not exported, skipping');
    }
  });

  await runTest('services command produces embed', async () => {
    if (typeof cmds.handleServicesCommand === 'function') {
      const msg = mockMessage();
      const result = await cmds.handleServicesCommand(mockS3(), msg);
      assert.ok(result);
    } else {
      console.log('\u23f3 handleServicesCommand not exported, skipping');
    }
  });

  await runTest('buildHelpEmbed is exported', () => {
    assert.equal(typeof cmds.buildHelpEmbed, 'function');
  });

  await runTest('buildStatusEmbed is exported', () => {
    assert.equal(typeof cmds.buildStatusEmbed, 'function');
  });

  await runTest('buildServicesEmbed is exported', () => {
    assert.equal(typeof cmds.buildServicesEmbed, 'function');
  });

  // ── !s3 db import staging step ────────────────────────────────────
  // The dev-harness cannot reach this branch: its message stub carries no
  // `attachments`, and it passes `stagedImportRef: { current: null }` precisely
  // to stay off the mutating paths. So these are the only automated proof that
  // the review embed says what it claims. `fetch` resolves data: URLs, which is
  // what lets us stand in for a Discord CDN attachment without a server.
  async function stageImport(args) {
    const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true } });
    await seq.authenticate();
    const db = new DBService({ sequelize: seq });
    await db.mount();
    const M = db.defineModel('Elo_PlayerStats',
      { eosID: { type: DataTypes.STRING, primaryKey: true }, rating: DataTypes.INTEGER },
      { timestamps: false, exportTier: 'historical' });
    await M.sync();
    await M.create({ eosID: 'p1', rating: 1500 });

    const { exportToJSON } = await import('../utils/s3-export-import.js');
    const backup = await exportToJSON(db);

    const captured = [];
    const stagedImportRef = { current: null };
    const { handlers } = cmds.createCommandHandlers({
      sendDiscordMessage: async (_c, payload) => { captured.push(payload); },
      watchManager: null,
      stagedImportRef
    });

    // A fresh target DB, so any write would be visible as a row appearing.
    const seq2 = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true } });
    await seq2.authenticate();
    const target = new DBService({ sequelize: seq2 });
    await target.mount();
    const T = target.defineModel('Elo_PlayerStats',
      { eosID: { type: DataTypes.STRING, primaryKey: true }, rating: DataTypes.INTEGER },
      { timestamps: false, exportTier: 'historical' });
    await T.sync();

    const url = 'data:application/json;base64,' + Buffer.from(JSON.stringify(backup)).toString('base64');
    const message = {
      channel: { id: 'c1', send: async (p) => { captured.push(p); return { id: 'x' }; } },
      author: { id: 'u1' },
      reply: async (p) => { captured.push(p); return { id: 'x' }; },
      attachments: { first: () => ({ url, name: 'test.s3backup.json' }) }
    };

    await handlers.get('db')({ services: { db: target }, verbose: () => {}, localize: (key, vars) => lookupMessage(key, vars) }, message, args);

    const embed = captured.map((p) => p?.embeds?.[0]).filter(Boolean).pop();
    const rows = await T.findAll({ raw: true });
    return { embed, rows, stagedImportRef };
  }

  await runTest('import staging states plainly that nothing was imported', async () => {
    const { embed, rows, stagedImportRef } = await stageImport(['db', 'import']);
    assert.ok(embed, 'the staging step must answer with an embed');
    assert.match(embed.title, /nothing has been imported/i,
      'the title must rule out the reading that data already went in');
    assert.match(embed.description, /No data has been written/i);
    assert.equal(embed.color, 0x3498db, 'a read-only preview must not use the amber warning colour');
    assert.equal(rows.length, 0, 'staging must not write to the target database');
    assert.ok(stagedImportRef.current, 'the parsed backup must still be staged for --confirm');
  });

  await runTest('import staging acknowledges --dry-run rather than ignoring it', async () => {
    // --dry-run is not read at this step. Silently accepting it let a caller
    // believe they had asked for something; now the embed says otherwise.
    const withFlag = await stageImport(['db', 'import', '--dry-run']);
    assert.match(withFlag.embed.description, /`--dry-run` has no effect here/,
      'passing --dry-run must be acknowledged, not swallowed');
    assert.equal(withFlag.rows.length, 0);

    const withoutFlag = await stageImport(['db', 'import']);
    assert.ok(!/has no effect here/.test(withoutFlag.embed.description),
      'the note must not appear when the flag was never passed');
  });

  await runTest('import staging does not oversell --confirm --dry-run', async () => {
    // importFromJSON's dryRun branch returns before resolving any model, so it
    // re-reports the file's own row counts and validates nothing further. An
    // earlier draft of this embed described it as validating against the live
    // database, which would invite trust in a green dry run that proves nothing.
    const { embed } = await stageImport(['db', 'import']);
    assert.match(embed.description, /!s3 db import --confirm`/,
      'the real-import route must be offered');
    assert.match(embed.description, /does \*\*not\*\* check them against the live schema/,
      'the limits of --confirm --dry-run must be stated, not glossed');
    assert.ok(!/validate against the live database/i.test(embed.description),
      'must not claim a live-schema validation that the dry-run path never performs');
  });
}

await main();
if (!process.exitCode) console.log('\nAll s3-commands tests passed.');