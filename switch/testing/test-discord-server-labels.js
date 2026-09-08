/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      SWITCH — SERVER LABELS ON DISCORD ADMIN OUTPUT           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * `status`, `stats` and `check` are `server-read` with
 * `selectorRequired: false`, which means they BROADCAST: every registered
 * server answers the one typed message with its own reply. Before this,
 * none of Switch's Discord admin sends carried a server label, so two
 * servers sharing an admin channel produced two embeds that were
 * byte-identical apart from whatever numbers happened to differ — and an
 * admin had no way to tell which server either one described. It was
 * observed live on a two-server rig: `!switch check <name>` returned two
 * embeds distinguishable only because the two servers had drifted to
 * different token caps, which is luck, not a design.
 *
 * A reply that quotes the command does not solve it either, because both
 * servers quote the same command.
 *
 * This pins the fix:
 *
 *   - embeds go out through applyServerLabel(), which writes the label into
 *     the author line above the title — the footer is where a label goes to
 *     be missed, since two broadcast answers are identical for their whole
 *     height and differ only below the fields;
 *   - plain-text answers have no embed to decorate, so they go through
 *     plugin.labelText(), which prefixes the server descriptor;
 *   - both are inert on a single-server install, which is what lets every
 *     call site invoke them unconditionally and never count servers;
 *   - the three single-responder sites (the routing refusal and the two
 *     help embeds) are deliberately NOT labelled — exactly one process
 *     ever emits those, so a label there names a server the reader did
 *     not need and could not have confused with another.
 *
 * Category: 1 (SQLite only, deliberately). Labelling is payload shaping —
 * it never reaches a WHERE clause, a column type or a datetime — so there
 * is nothing here a second engine could disagree about. The database is
 * present only because the plugin harness needs one to register against.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-discord-server-labels.js
 *
 * Do not run this file at the same time as another suite in the monorepo;
 * see switch/testing/run-all-tests.js for why.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Sequelize } from 'sequelize';

import DBService from '../../s3/utils/db-service.js';
import SwitchDB from '../utils/switch-db.js';
import SwitchOutput from '../utils/switch-output.js';
import SwitchQueue from '../utils/switch-queue.js';
import SwitchCommands from '../utils/switch-commands.js';
import SwitchExplain from '../utils/switch-explain.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';

const ASSEMBLY = buildAssembly('.tmp-switch-server-labels');
// An assembly left behind in the repo root is not inert: a stray flattened
// copy is picked up by test-i18n.js and fakes a locale-tier failure with
// nothing wrong in the code. Registered before the first await so it survives
// a throw anywhere below, not just a clean finish.
process.on('exit', () => cleanAssembly(ASSEMBLY));

const Switch = await importFromAssembly(ASSEMBLY, 'switch.js');

// The published label lives in module scope, so it has to be published into
// the ASSEMBLY's copy of s3-server-label.js — importing it from the repo path
// instead yields a second, unrelated module instance whose label the plugin
// never reads. That mistake fails open: every assertion that the label is
// ABSENT still passes, so a broken harness reads as a green single-server
// case. importFromAssembly() is not usable here — it resolves `plugins/` and
// returns a default export, and this is a named export under `utils/`.
const { publishServerLabel } = await import(
  pathToFileURL(path.join(ASSEMBLY, 'utils', 's3-server-label.js')).href
);

const SQLITE = { dialect: 'sqlite', storage: ':memory:', logging: false };
const LABEL = "Slacker's Test Server 2";

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    if (process.env.SWITCH_TEST_STACK) console.error(err.stack);
    failed++;
  }
}

/**
 * A registered Switch plugin with the Discord surface attached.
 *
 * `serverDescriptor()` and the published label are two different sources on
 * purpose, and the plugin base is where that split lives: applyServerLabel()
 * reads the published label, while serverDescriptor() falls back through
 * alias to `#<id>` so an admin-facing line always says something. A real
 * multi-server install has both; a single-server install has neither, which
 * is the inert case both helpers are built around.
 */
async function buildPlugin({ multiServer } = { multiServer: true }) {
  const seq = new Sequelize(SQLITE);
  const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 1, baseDelayMs: 0, jitterMs: 0 } });
  await db.mount();

  const server = { players: [], on: () => {}, off: () => {}, removeListener: () => {} };
  const plugin = new Switch(server, { maxSwitchTokens: 2, switchCooldownHours: 1.75 }, {});

  Object.assign(plugin, {
    verbose: () => {},
    warn: () => {},
    sendDiscordMessage: async () => {},
    reportError: () => {},
    _s3db: db,
    _getModel: (n) => db.getModel(n),
    verifyAndRunMigrations: async () => null,
    _withDb: async (fn) => db.withTransactionWithRetry(fn),
    _s3: {
      gameState: {
        isSeedMode: () => false,
        getMatchId: () => 'round-current',
        getLayerName: () => 'Narva_RAAS_v1',
        getGamemode: () => 'RAAS',
        getPhase: () => 'LIVE'
      },
      players: { isReady: () => true, getAllPlayers: () => [], getPlayer: () => null }
    },
    getSecondsFromJoin: async () => 9999,
    getSecondsFromMatchStart: () => 9999,
    // The routing gate is S³'s and is covered by s3/testing/test-discord-routing.js.
    // Stubbed to `act` so these cases exercise the send sites rather than re-testing
    // the gate that decides whether they are reached.
    routeDiscordCommand: async ({ args }) => ({ routing: 'act', args }),
    serverDescriptor: () => (multiServer ? LABEL : null)
  });

  SwitchOutput.register(plugin);
  SwitchQueue.register(plugin);
  SwitchCommands.register(plugin);
  SwitchExplain.register(plugin);
  await SwitchDB.register(plugin);
  db.migrationEngine.confirmToken('__force__');
  await db.migrationEngine.runMigrations('switch');

  publishServerLabel(multiServer ? LABEL : null);

  return { plugin, db, seq };
}

async function teardown({ seq }) {
  publishServerLabel(null);
  try { await seq?.close(); } catch { /* best effort */ }
}

/** A Discord message mock that records everything sent back to its channel. */
function discordMessage(content) {
  const sent = [];
  return {
    sent,
    message: {
      id: 'msg-1',
      author: { bot: false },
      content,
      channel: { id: 'admin-chan', send: async (payload) => { sent.push(payload); } },
      reply: async (payload) => { sent.push(payload); }
    }
  };
}

const authors = (sent) => sent.flatMap((p) => (p.embeds || []).map((e) => e.author?.name ?? ''));
const footers = (sent) => sent.flatMap((p) => (p.embeds || []).map((e) => e.footer?.text ?? ''));

console.log('\n🧪 Switch Discord Server Labels — broadcast disambiguation\n');

// ═══════════════════════════════════════════════════════════════════
// 1. Broadcast embeds carry the label
// ═══════════════════════════════════════════════════════════════════

await runTest('the status embed is labelled when more than one server is registered', async () => {
  const ctx = await buildPlugin({ multiServer: true });
  try {
    const { sent, message } = discordMessage('!switch status');
    await ctx.plugin.onDiscordMessage(message);

    assert.equal(sent.length, 1, 'status should answer with exactly one payload');
    const text = authors(sent)[0];
    assert.ok(text.includes(LABEL), `the status author line should name the server, got: ${JSON.stringify(text)}`);
  } finally {
    await teardown(ctx);
  }
});

await runTest('the status embed is untouched on a single-server install', async () => {
  const ctx = await buildPlugin({ multiServer: false });
  try {
    const { sent, message } = discordMessage('!switch status');
    await ctx.plugin.onDiscordMessage(message);

    assert.equal(sent.length, 1);
    // Not merely "no LABEL" — a single-server install must render exactly what
    // it rendered before any of this existed, author line and footer included.
    assert.ok(!authors(sent)[0].includes(LABEL), 'a lone server should add no label at all');
    assert.ok(!footers(sent)[0].includes(LABEL), 'and nothing in the footer either');
  } finally {
    await teardown(ctx);
  }
});

await runTest('the label lands in the author line, above the title', async () => {
  const ctx = await buildPlugin({ multiServer: true });
  try {
    // The status diagnostic embed is the case this whole suite exists for:
    // two of them arrive together, identical down to the last field, and the
    // author line is the first thing above the title that can tell them apart.
    const { sent, message } = discordMessage('!switch status');
    await ctx.plugin.onDiscordMessage(message);

    assert.equal(authors(sent)[0], LABEL,
      'the author line should be the label and nothing else');
  } finally {
    await teardown(ctx);
  }
});

await runTest('an existing footer is left exactly as the caller wrote it', async () => {
  const ctx = await buildPlugin({ multiServer: true });
  try {
    // The footer used to be where the label went, so the embeds that already
    // said something there — the round summary's version string, the stats
    // embed's — had the label joined onto it. Now the two do not compete: the
    // version stamp keeps its line and the label has its own.
    const labelled = ctx.plugin.applyServerLabel({
      embeds: [{ title: 'Diagnostics', footer: { text: 'Switch v2.6.0' } }]
    });

    assert.equal(labelled.embeds[0].footer.text, 'Switch v2.6.0',
      'the version stamp should be untouched');
    assert.equal(labelled.embeds[0].author.name, LABEL,
      'and the label should be in the author line instead');
  } finally {
    await teardown(ctx);
  }
});

await runTest('a title that already names the server suppresses the author line', async () => {
  const ctx = await buildPlugin({ multiServer: true });
  try {
    // titleWithServer() puts the server at the front of a mutation's title,
    // which renders directly beneath the author line. Labelling both prints
    // the server name twice, stacked, on exactly the replies that matter most.
    const labelled = ctx.plugin.applyServerLabel({
      embeds: [{ title: `${LABEL} — Switches Cleared` }]
    });

    assert.equal(labelled.embeds[0].author, undefined,
      'a title that already leads with the server should not get an author line too');
  } finally {
    await teardown(ctx);
  }
});

await runTest('re-labelling an already-labelled payload does not stack the label', async () => {
  const ctx = await buildPlugin({ multiServer: true });
  try {
    // The senders re-send the same payload object on a 429, and s3-discord.js
    // re-wraps it for the v12 fallback shape, so this runs more than once on
    // one embed in normal operation.
    const once = ctx.plugin.applyServerLabel({ embeds: [{ footer: { text: 'Round 42' } }] });
    const twice = ctx.plugin.applyServerLabel(once);

    const text = twice.embeds[0].author.name;
    // Asserted present before asserted-once: "appears zero times" also satisfies
    // indexOf === lastIndexOf, so without this the case passes on a harness that
    // never published a label at all.
    assert.ok(text.includes(LABEL), `the label should be applied at least once, got: ${JSON.stringify(text)}`);
    assert.equal(text.indexOf(LABEL), text.lastIndexOf(LABEL), `the label should appear once, got: ${JSON.stringify(text)}`);
    assert.equal(twice.embeds[0].footer.text, 'Round 42', 'and the original footer should survive');
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. Plain-text answers, which have no embed to decorate
// ═══════════════════════════════════════════════════════════════════

await runTest('labelText prefixes a plain-text answer when the community has several servers', async () => {
  const ctx = await buildPlugin({ multiServer: true });
  try {
    assert.ok(ctx.plugin.labelText('Backfill complete.').includes(LABEL));
  } finally {
    await teardown(ctx);
  }
});

await runTest('labelText returns the text unchanged on a single-server install', async () => {
  const ctx = await buildPlugin({ multiServer: false });
  try {
    assert.equal(ctx.plugin.labelText('Backfill complete.'), 'Backfill complete.');
  } finally {
    await teardown(ctx);
  }
});

await runTest('safeDiscordReply labels what it sends', async () => {
  const ctx = await buildPlugin({ multiServer: true });
  try {
    const { sent, message } = discordMessage('!switch timelimit');
    await ctx.plugin.safeDiscordReply(message, 'Setting updated.');

    assert.equal(sent.length, 1);
    assert.ok(String(sent[0]).includes(LABEL), `the reply should name the server, got: ${JSON.stringify(sent[0])}`);
  } finally {
    await teardown(ctx);
  }
});

await runTest('a backfill refusal names the server that refused', async () => {
  const ctx = await buildPlugin({ multiServer: true });
  try {
    // No reporting channel configured, which is the branch that answers with a
    // bare string rather than an embed — the shape applyServerLabel cannot help.
    ctx.plugin.channel = null;
    const { sent, message } = discordMessage('!switch backfill');
    await ctx.plugin._handleBackfillCommand(message, []);

    assert.equal(sent.length, 1, 'the refusal should be the only thing sent');
    assert.ok(String(sent[0]).includes(LABEL),
      `an admin needs to know WHICH server has no reporting channel, got: ${JSON.stringify(sent[0])}`);
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. The single-responder sites stay bare
// ═══════════════════════════════════════════════════════════════════

await runTest('the help embed is not labelled, because only one server ever answers it', async () => {
  const ctx = await buildPlugin({ multiServer: true });
  try {
    const { sent, message } = discordMessage('!switch help');
    await ctx.plugin.onDiscordMessage(message);

    assert.equal(sent.length, 1);
    // `help` is community-read: exactly one process claims the message key and
    // replies. Labelling it would name a server the reader never had to
    // disambiguate, on text that is identical from every server anyway.
    assert.ok(!authors(sent)[0].includes(LABEL), 'a single-responder reply should stay bare');
  } finally {
    await teardown(ctx);
  }
});

console.log(`\n📊 Results: ${passed}/${passed + failed} passed, ${failed} failed, 0 skipped\n`);

process.exit(failed > 0 ? 1 : 0);
