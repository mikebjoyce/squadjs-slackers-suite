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

// ── !s3 servers ───────────────────────────────────────────────────
  // The listing itself is covered by test-s3-commands-embeds.js. What is only
  // reachable through the handler is the refusal shape: an ambiguous or unknown
  // token, a rejected rename, and forgetting the server you are typing at. Each
  // of those is a path where the wrong answer targets the wrong live game.

  async function serversFixture(fn) {
    const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true } });
    const db = new DBService({ sequelize: seq, serverID: 1, verboseLogger: () => {} });
    await db.mount();

    const captured = [];
    const { handlers } = cmds.createCommandHandlers({
      sendDiscordMessage: async (_c, payload) => { captured.push(payload); },
      watchManager: null,
      stagedImportRef: { current: null }
    });

    const plugin = {
      services: { db },
      verbose: () => {},
      localize: (key, vars) => lookupMessage(key, vars)
    };

    const now = await db.dbNow();
    const seed = (serverID, alias, stale) => db.ServersModel.create({
      serverID, alias, serverName: `Server ${serverID}`,
      host: '10.0.0.1', queryPort: 27165, rconPort: 21114 + serverID,
      suiteVersion: '1.7.0', firstSeenAt: now,
      lastSeenAt: stale ? now - 60 * 60 * 1000 : now,
      clockSkewMs: 0, communityOptions: null
    });

    const run = async (...args) => {
      captured.length = 0;
      await handlers.get('servers')(plugin, mockMessage(), ['servers', ...args]);
      return captured.at(-1).embeds[0];
    };

    try {
      return await fn({ db, seed, run });
    } finally {
      try { await db.unmount(); } catch { /* best effort */ }
      try { await seq.close(); } catch { /* best effort */ }
    }
  }

  await runTest('!s3 servers alias renames a server and reports the previous name', () =>
    serversFixture(async ({ db, seed, run }) => {
      await seed(1, 'main', false);
      await seed(2, 'event', true);

      const embed = await run('alias', 'event', 'Weekend');
      assert.match(embed.title, /Alias Set/);
      assert.match(embed.description, /event/, 'the reply has to say what the name was, not only what it is');
      assert.match(embed.description, /weekend/, 'the stored alias is the normalised form, and that is what --server will take');

      const rows = await db.getRegisteredServers();
      assert.equal(rows.find((r) => r.serverID === 2).alias, 'weekend');
    }));

  await runTest('!s3 servers alias refuses a name a keystroke from another, and changes nothing', () =>
    serversFixture(async ({ db, seed, run }) => {
      await seed(1, 'main', false);
      await seed(2, 'event', true);

      const embed = await run('alias', '2', 'mains');
      assert.match(embed.title, /Refused/);
      assert.match(embed.description, /one edit away/);

      const rows = await db.getRegisteredServers();
      assert.equal(rows.find((r) => r.serverID === 2).alias, 'event', 'a refused rename must not half-apply');
    }));

  await runTest('!s3 servers on an unknown token lists what does exist', () =>
    serversFixture(async ({ seed, run }) => {
      await seed(1, 'main', false);

      const embed = await run('alias', 'nosuch', 'whatever');
      assert.match(embed.title, /No Such Server/);
      assert.match(embed.description, /main/, 'being told "no" without being told the alternatives is a dead end');
    }));

  await runTest('!s3 servers forget refuses the server it is typed at', () =>
    serversFixture(async ({ db, seed, run }) => {
      await seed(1, 'main', false);

      const embed = await run('forget', 'main');
      assert.match(embed.title, /Not Forgotten/);
      assert.match(embed.description, /cannot deregister itself/);
      assert.equal(await db.getRegisteredServerCount(), 1);
    }));

  await runTest('!s3 servers forget removes a retired server', () =>
    serversFixture(async ({ db, seed, run }) => {
      await seed(1, 'main', false);
      await seed(2, 'event', true);

      const embed = await run('forget', 'event');
      assert.match(embed.title, /Forgotten/);
      assert.deepEqual((await db.getRegisteredServers()).map((r) => r.serverID), [1]);
    }));

  await runTest('!s3 servers with a mistyped subcommand replies with usage, never a default action', () =>
    serversFixture(async ({ seed, run }) => {
      await seed(1, 'main', false);

      const embed = await run('forgt', 'main');
      assert.match(embed.title, /Usage/);
      assert.match(embed.description, /forgt/, 'the operator has to be able to see what they typed');
    }));

  await runTest('!s3 servers alias with a missing argument replies with usage', () =>
    serversFixture(async ({ seed, run }) => {
      await seed(1, 'main', false);

      const embed = await run('alias', 'main');
      assert.match(embed.title, /Usage/);
      assert.match(embed.description, /newAlias/);
    }));

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