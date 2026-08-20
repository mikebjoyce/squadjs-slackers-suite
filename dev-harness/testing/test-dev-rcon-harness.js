/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          DEV RCON HARNESS TEST                               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Exercises the file-drop command channel end to end: request parsing,
 * token and allowlist refusals, RCON failure reporting, state snapshots,
 * the event tape, and mount/unmount symmetry.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-dev-rcon-harness.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - No running SquadJS required; server, RCON and S³ are all mocked.
 * - The plugin imports './base-plugin.js', which exists only inside a
 *   real SquadJS tree. Rather than shipping a stub in dev-harness/plugins/
 *   — where an install could copy it over SquadJS's real base-plugin —
 *   the test assembles a throwaway sandbox in the OS temp dir and loads
 *   the plugin from there.
 * - The mocks prove the harness's own logic only. They say nothing about
 *   whether real RCON accepts a given command.
 *
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, '..', 'plugins', 'dev-rcon-harness.js');

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-rcon-harness-'));
const DATA = path.join(SANDBOX, 'data');

await fs.mkdir(path.join(SANDBOX, 'plugins'), { recursive: true });
await fs.writeFile(
  path.join(SANDBOX, 'plugins', 'base-plugin.js'),
  `export default class BasePlugin {
  constructor(server, options, connectors) {
    this.server = server;
    this.connectors = connectors;
    const spec = this.constructor.optionsSpecification || {};
    const defaults = {};
    for (const [key, def] of Object.entries(spec)) defaults[key] = def.default;
    this.options = { ...defaults, ...options };
    this.logs = [];
  }
  verbose(level, message) { this.logs.push(\`[v\${level}] \${message}\`); }
}
`,
  'utf8'
);
await fs.copyFile(PLUGIN_SRC, path.join(SANDBOX, 'plugins', 'dev-rcon-harness.js'));

const { default: DevRconHarness } = await import(
  pathToFileURL(path.join(SANDBOX, 'plugins', 'dev-rcon-harness.js')).href
);

class MockRcon {
  constructor() {
    this.executed = [];
    this.failOn = null;
  }

  async execute(command) {
    this.executed.push(command);
    if (this.failOn && command.includes(this.failOn)) throw new Error('rcon exploded');
    return `ok: ${command}`;
  }
}

class MockServer extends EventEmitter {
  constructor({ withS3 = true } = {}) {
    super();
    this.rcon = new MockRcon();
    this.players = [{ teamID: 1 }, { teamID: 2 }];
    this.squads = [];
    this.currentLayer = { name: 'Gorodok_RAAS_v1' };
    this.nextLayer = { name: 'Yehorivka_AAS_v1' };
    this.layerHistory = [{ layer: { name: 'Gorodok_RAAS_v1' } }, { layer: { name: 'Narva_RAAS_v1' } }];
    this.a2sPlayerCount = 2;
    this.plugins = withS3 ? [makeS3()] : [];
  }
}

function makeS3() {
  const s3 = {
    // The real ready() returns a PROMISE, not a boolean — the snapshot must not
    // call it. Mirror that here so the mock cannot flatter the implementation.
    ready: () => Promise.resolve(true),
    gameState: {
      lastNewGameAt: 1700000000000,
      getPhase: () => 'STAGING',
      isResolving: () => true,
      isLayerResolved: () => true,
      getLayerName: () => 'Gorodok_RAAS_v1',
      getGamemode: () => 'RAAS',
      isSeedMode: () => false,
      isTrainingMode: () => false
    },
    players: {
      isReady: () => true,
      getAllPlayers: () => [{}, {}],
      areTeamsResolved: () => false,
      getEffectiveRefreshIntervalMs: () => 20000
    },
    factions: {
      getCachedAbbreviations: () => ({ 1: 'US', 2: 'MEA' })
    }
  };
  // The real plugin exposes services both as a map and as flat getters.
  s3.services = { gameState: s3.gameState, players: s3.players, factions: s3.factions };
  // constructor.name is how every S³ consumer discovers the plugin.
  Object.defineProperty(s3, 'constructor', { value: { name: 'SlackersSquadServices' } });
  return s3;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function drop(name, body) {
  // write-then-rename, mirroring how a caller should stage a request
  const tmp = path.join(DATA, 'inbox', `.${name}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(body), 'utf8');
  await fs.rename(tmp, path.join(DATA, 'inbox', name));
}

async function collect(name, timeoutMs = 3000) {
  const target = path.join(DATA, 'outbox', name);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(target, 'utf8'));
    } catch {
      await wait(25);
    }
  }
  throw new Error(`no result file appeared for ${name}`);
}

function build(server, overrides = {}) {
  return new DevRconHarness(server, {
    enabled: true,
    token: 'secret-token',
    dataDir: DATA,
    scanIntervalMs: 40,
    commandDelayMs: 0,
    ...overrides
  }, {});
}

await fs.rm(DATA, { recursive: true, force: true });

// ── 1. happy path ────────────────────────────────────────────────────────────
{
  const server = new MockServer();
  const plugin = build(server);
  await plugin.mount();

  await drop('roll.json', { token: 'secret-token', command: 'AdminChangeLayer Narva_RAAS_v1', note: 'roll test' });
  const result = await collect('roll.json');

  await test('executes an allowed command and reports the RCON response', async () => {
    assert.equal(result.ok, true);
    assert.equal(result.results[0].command, 'AdminChangeLayer Narva_RAAS_v1');
    assert.equal(result.results[0].response, 'ok: AdminChangeLayer Narva_RAAS_v1');
    assert.deepEqual(server.rcon.executed, ['AdminChangeLayer Narva_RAAS_v1']);
    assert.equal(result.note, 'roll test');
  });

  await test('result carries an S3 snapshot with live phase/resolving state', async () => {
    assert.equal(result.snapshot.s3.present, true);
    assert.deepEqual(result.snapshot.s3.services, ["factions", "gameState", "players"]);
    assert.equal(result.snapshot.s3.gameState.phase, 'STAGING');
    assert.equal(result.snapshot.s3.gameState.resolving, true);
    assert.equal(result.snapshot.s3.gameState.layerResolved, true);
    assert.equal(result.snapshot.s3.players.refreshIntervalMs, 20000);
    assert.deepEqual(result.snapshot.s3.factions.abbreviations, { 1: 'US', 2: 'MEA' });
    assert.equal(result.snapshot.server.currentLayer, 'Gorodok_RAAS_v1');
    assert.deepEqual(result.snapshot.server.layerHistoryTop, ['Gorodok_RAAS_v1', 'Narva_RAAS_v1']);
  });

  await test('the request is moved out of the inbox and kept for audit', async () => {
    assert.deepEqual(await fs.readdir(path.join(DATA, 'inbox')), []);
    assert.ok((await fs.readdir(path.join(DATA, 'processed'))).includes('roll.json'));
  });

  // ── 2. refusals ────────────────────────────────────────────────────────────
  server.rcon.executed.length = 0;

  await drop('badtoken.json', { token: 'wrong', command: 'AdminRestartMatch' });
  const bad = await collect('badtoken.json');
  await test('a bad token is refused without touching RCON', async () => {
    assert.equal(bad.ok, false);
    assert.match(bad.error, /token/i);
    assert.deepEqual(server.rcon.executed, []);
  });

  await drop('ban.json', { token: 'secret-token', command: 'AdminBan "76561198000000000" 1d cheating' });
  const banned = await collect('ban.json');
  await test('a command outside allowedCommands is refused without touching RCON', async () => {
    assert.equal(banned.ok, false);
    assert.match(banned.results[0].error, /allowedCommands/);
    assert.deepEqual(server.rcon.executed, []);
  });

  await drop('toomany.json', { token: 'secret-token', commands: Array(11).fill('AdminRestartMatch') });
  const tooMany = await collect('toomany.json');
  await test('an oversized batch is refused whole', async () => {
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.error, /maxCommandsPerRequest/);
    assert.deepEqual(server.rcon.executed, []);
  });

  // ── 3. RCON failure is reported, not swallowed ─────────────────────────────
  server.rcon.failOn = 'AdminEndMatch';
  await drop('endmatch.json', { token: 'secret-token', command: 'AdminEndMatch' });
  const failed = await collect('endmatch.json');
  await test('an RCON rejection is reported in the result file', async () => {
    assert.equal(failed.ok, false);
    assert.equal(failed.results[0].error, 'rcon exploded');
  });
  server.rcon.failOn = null;

  // ── 4. snapshot-only request never touches RCON ────────────────────────────
  server.rcon.executed.length = 0;
  await drop('peek.json', { token: 'secret-token', snapshot: true });
  const peek = await collect('peek.json');
  await test('a commandless request is a pure read', async () => {
    assert.equal(peek.ok, true);
    assert.deepEqual(peek.results, []);
    assert.equal(peek.snapshot.s3.gameState.phase, 'STAGING');
    assert.deepEqual(server.rcon.executed, []);
  });

  // ── 5. the tape ────────────────────────────────────────────────────────────
  server.emit('NEW_GAME', { layer: { name: 'Narva_RAAS_v1' } });
  server.emit('UPDATED_PLAYER_INFORMATION');
  await wait(120);

  const tape = (await fs.readFile(path.join(DATA, 'tape.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  await test('the tape records lifecycle events with phase/resolving at that instant', async () => {
    const newGame = tape.find((l) => l.event === 'NEW_GAME');
    const tick = tape.find((l) => l.event === 'UPDATED_PLAYER_INFORMATION');
    assert.ok(newGame, 'no NEW_GAME line');
    assert.ok(tick, 'no UPDATED_PLAYER_INFORMATION line');
    assert.equal(newGame.eventLayer, 'Narva_RAAS_v1');
    assert.equal(newGame.s3.gameState.resolving, true);
    assert.equal(tick.s3.players.teamsResolved, false);
    assert.ok(Date.parse(newGame.ts) > 0);
  });

  // ── 6. unmount is symmetric ────────────────────────────────────────────────
  await plugin.unmount();
  await test('unmount clears the timer and every listener', async () => {
    for (const event of DevRconHarness.TAPE_EVENTS) {
      assert.equal(server.listenerCount(event), 0, `${event} still bound`);
    }
    assert.equal(plugin._scanTimer, null);
  });

  await test('nothing is processed after unmount', async () => {
    await drop('after-unmount.json', { token: 'secret-token', command: 'AdminRestartMatch' });
    await wait(150);
    assert.ok((await fs.readdir(path.join(DATA, 'inbox'))).includes('after-unmount.json'));
  });
  await fs.rm(path.join(DATA, 'inbox', 'after-unmount.json'), { force: true });
}

// ── 7. readOnly mode ─────────────────────────────────────────────────────────
{
  const server = new MockServer();
  const plugin = build(server, { readOnly: true });
  await plugin.mount();

  await test('readOnly records the tape but opens no inbox', async () => {
    assert.equal(plugin._scanTimer, null);
    assert.equal(server.listenerCount('NEW_GAME'), 1);

    server.emit('ROUND_ENDED');
    await wait(80);
    const tape = (await fs.readFile(path.join(DATA, 'tape.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.ok(tape.some((l) => JSON.parse(l).event === 'ROUND_ENDED'));

    await fs.mkdir(path.join(DATA, 'inbox'), { recursive: true });
    await drop('readonly.json', { token: 'secret-token', command: 'AdminRestartMatch' });
    await wait(150);
    assert.deepEqual(server.rcon.executed, []);
    assert.ok((await fs.readdir(path.join(DATA, 'inbox'))).includes('readonly.json'));
  });

  await plugin.unmount();
  await fs.rm(path.join(DATA, 'inbox', 'readonly.json'), { force: true });
}

// ── 8. an unconfigured token keeps the inbox shut ────────────────────────────
{
  const server = new MockServer();
  const plugin = build(server, { token: 'CHANGE_ME' });
  await plugin.mount();

  await test('default token keeps the inbox shut while the tape still runs', async () => {
    assert.equal(plugin._scanTimer, null);
    assert.equal(server.listenerCount('NEW_GAME'), 1);
    await drop('unconfigured.json', { token: 'CHANGE_ME', command: 'AdminRestartMatch' });
    await wait(150);
    assert.deepEqual(server.rcon.executed, []);
  });

  await plugin.unmount();
  await fs.rm(path.join(DATA, 'inbox', 'unconfigured.json'), { force: true });
}

// ── 9. enabled:false is inert ────────────────────────────────────────────────
{
  const server = new MockServer();
  const plugin = build(server, { enabled: false });
  await plugin.mount();

  await test('enabled:false binds nothing at all', async () => {
    assert.equal(plugin._scanTimer, null);
    for (const event of DevRconHarness.TAPE_EVENTS) {
      assert.equal(server.listenerCount(event), 0);
    }
  });

  await plugin.unmount();
}

// ── 10. survives a missing / broken S3 ───────────────────────────────────────
{
  const server = new MockServer({ withS3: false });
  const plugin = build(server, { dataDir: path.join(DATA, 'nos3') });
  await plugin.mount();

  await fs.mkdir(path.join(DATA, 'nos3', 'inbox'), { recursive: true });
  const tmp = path.join(DATA, 'nos3', 'inbox', 'peek.json');
  await fs.writeFile(tmp, JSON.stringify({ token: 'secret-token', snapshot: true }), 'utf8');

  const deadline = Date.now() + 3000;
  let out = null;
  while (Date.now() < deadline && !out) {
    try { out = JSON.parse(await fs.readFile(path.join(DATA, 'nos3', 'outbox', 'peek.json'), 'utf8')); }
    catch { await wait(25); }
  }

  await test('snapshot still works when S3 is absent', async () => {
    assert.ok(out, 'no result file');
    assert.equal(out.ok, true);
    assert.equal(out.snapshot.s3.present, false);
    assert.equal(out.snapshot.server.currentLayer, 'Gorodok_RAAS_v1');
  });

  await plugin.unmount();
}

// ── 11. a throwing S3 accessor degrades to an error string ───────────────────
{
  const server = new MockServer();
  server.plugins[0].gameState.getPhase = () => { throw new Error('gameState is on fire'); };
  const plugin = build(server, { dataDir: path.join(DATA, 'brokens3') });
  await plugin.mount();

  await test('a throwing accessor does not abort the whole snapshot', async () => {
    const snap = plugin.buildSnapshot();
    assert.match(snap.s3.gameState.phase, /gameState is on fire/);
    assert.equal(snap.s3.gameState.resolving, true);
  });

  await plugin.unmount();
}

// ── 12. Discord capture ──────────────────────────────────────────────────────
{
  // A stand-in s3-commands.js placed where the plugin expects it (../utils/).
  // It records whether the real sender was ever called with a real channel.
  const sent = [];
  await fs.mkdir(path.join(SANDBOX, 'utils'), { recursive: true });
  await fs.writeFile(
    path.join(SANDBOX, 'utils', 's3-commands.js'),
    `export function createCommandHandlers({ sendDiscordMessage, watchManager, stagedImportRef }) {
  const handlers = new Map();
  handlers.set('gamestate', async (plugin, message, args) => {
    await sendDiscordMessage(message.channel, {
      embeds: [{ title: 'Game State', fields: [
        { name: 'Layer', value: plugin.gameState.getLayerName() },
        { name: 'Phase', value: plugin.gameState.getPhase() },
        { name: 'Args', value: JSON.stringify(args) }
      ] }]
    }, 'S3', () => {});
  });
  handlers.set('explode', async () => { throw new Error('handler blew up'); });
  handlers.set('import', async () => { stagedImportRef.current = 'MUTATED'; });
  return { handlers, runDiagnostic: () => {} };
}
`,
    'utf8'
  );

  const server = new MockServer();
  const plugin = build(server, { dataDir: path.join(DATA, 'discord') });
  await plugin.mount();
  await fs.mkdir(path.join(DATA, 'discord', 'inbox'), { recursive: true });

  const dropTo = async (dir, name, body) => {
    const tmp = path.join(DATA, dir, 'inbox', `.${name}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(body), 'utf8');
    await fs.rename(tmp, path.join(DATA, dir, 'inbox', name));
  };
  const collectFrom = async (dir, name) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { return JSON.parse(await fs.readFile(path.join(DATA, dir, 'outbox', name), 'utf8')); }
      catch { await wait(25); }
    }
    throw new Error(`no result for ${name}`);
  };

  await dropTo('discord', 'gs.json', { token: 'secret-token', discord: ['gamestate verbose'] });
  const gs = await collectFrom('discord', 'gs.json');

  await test('a discord command is captured with the real embed, never sent', async () => {
    assert.equal(gs.ok, true);
    const fields = gs.discord[0].payloads[0].embeds[0].fields;
    assert.equal(fields.find((f) => f.name === 'Layer').value, 'Gorodok_RAAS_v1');
    assert.equal(fields.find((f) => f.name === 'Phase').value, 'STAGING');
    // args are forwarded after the subcommand word
    // The full token list, INCLUDING the subcommand — this mirrors
    // s3-discord.js, which builds args from everything after "!s3" and reads the
    // subcommand as args[0]. Handlers index from args[1] onward, so passing only
    // the tail shifted every multi-token command by one and made
    // `db export --all` fall through to its usage text.
    assert.equal(fields.find((f) => f.name === 'Args').value, '["gamestate","verbose"]');
    assert.deepEqual(sent, [], 'nothing may reach a real channel');
    assert.deepEqual(server.rcon.executed, [], 'discord capture must not touch RCON');
  });

  await dropTo('discord', 'blocked.json', { token: 'secret-token', discord: ['import', 'explode'] });
  const blocked = await collectFrom('discord', 'blocked.json');

  await test('mutating subcommands are refused and a throwing handler is reported', async () => {
    assert.equal(blocked.ok, false);
    assert.match(blocked.discord[0].error, /not in discordCommands/);
    assert.match(blocked.discord[1].error, /not in discordCommands/);
  });

  await plugin.unmount();
}

// ── 13. missing s3-commands.js degrades gracefully ───────────────────────────
{
  const server = new MockServer();
  const plugin = build(server, {
    dataDir: path.join(DATA, 'nocmds'),
    s3CommandsModule: '../utils/does-not-exist.js'
  });
  await plugin.mount();
  await fs.mkdir(path.join(DATA, 'nocmds', 'inbox'), { recursive: true });

  const tmp = path.join(DATA, 'nocmds', 'inbox', '.q.json.tmp');
  await fs.writeFile(tmp, JSON.stringify({ token: 'secret-token', discord: ['gamestate'] }), 'utf8');
  await fs.rename(tmp, path.join(DATA, 'nocmds', 'inbox', 'q.json'));

  const deadline = Date.now() + 3000;
  let out = null;
  while (Date.now() < deadline && !out) {
    try { out = JSON.parse(await fs.readFile(path.join(DATA, 'nocmds', 'outbox', 'q.json'), 'utf8')); }
    catch { await wait(25); }
  }

  await test('a missing s3-commands.js reports instead of crashing the scan loop', async () => {
    assert.ok(out, 'no result file');
    assert.equal(out.ok, false);
    assert.match(out.discord[0].error, /Could not load s3-commands\.js/);
    assert.ok(out.snapshot, 'snapshot should still be produced');
  });

  await plugin.unmount();
}

await fs.rm(SANDBOX, { recursive: true, force: true });

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed.`);
if (!process.exitCode) console.log('\nAll dev-rcon-harness tests passed.');
