/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     _requestTeamChange() RCON ARGUMENT REGRESSION TEST        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Loads the real s3-plugin-base.js (not a re-implemented stub) and
 * asserts _requestTeamChange() sends AdminForceTeamChange via
 * rcon.execute(), cascading eosID -> steamID -> playerName, stopping
 * at the first identifier the server accepts.
 *
 * Regression covered: _requestTeamChange() used to send playerName
 * outright. Squad's AdminForceTeamChange partial-matches a plain
 * name against every connected player, so a short name (e.g. "Hunt")
 * could resolve to an unrelated player whose name merely contains it
 * (e.g. "Hunty"), toggling the wrong player's team. A follow-up fix
 * switched to eosID only — but live RCON testing found a player's
 * eosID (bare and "EOS:"-prefixed) rejected with "Unable to find
 * player" on one server, and accepted for the same player on another;
 * steamID/playerName worked both times. The difference tracked with
 * whether the connection had populated a steamID, not the server
 * itself — no single identifier can be trusted to work for a given
 * player. So _requestTeamChange() must cascade past a rejection
 * instead of trusting eosID alone, and must still prefer eosID/steamID
 * over the ambiguous playerName whenever one of those is accepted.
 *
 * Category: 2 (sandboxed real-file import, no live server)
 * Run:    node s3/testing/test-request-team-change-eosid.js
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, '..', 'plugins', 's3-plugin-base.js');

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), 's3-plugin-base-'));
await fs.mkdir(path.join(SANDBOX, 'plugins'), { recursive: true });
await fs.mkdir(path.join(SANDBOX, 'utils'), { recursive: true });

// s3-plugin-base.js imports these via relative '../utils/...' paths.
for (const utilFile of ['s3-stderr.js', 's3-common.js']) {
  await fs.copyFile(
    path.join(HERE, '..', 'utils', utilFile),
    path.join(SANDBOX, 'utils', utilFile)
  );
}

await fs.writeFile(
  path.join(SANDBOX, 'plugins', 'base-plugin.js'),
  `export default class BasePlugin {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = options;
    this.connectors = connectors;
    this.logs = [];
  }
  verbose(level, message) { this.logs.push(\`[v\${level}] \${message}\`); }
}
`,
  'utf8'
);
await fs.copyFile(PLUGIN_SRC, path.join(SANDBOX, 'plugins', 's3-plugin-base.js'));

const { default: S3PluginBase } = await import(
  pathToFileURL(path.join(SANDBOX, 'plugins', 's3-plugin-base.js')).href
);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const EOS_ID = 'EOS:decoy-target';
const STEAM_ID = 'steam-decoy-target';
const BYSTANDER_EOS_ID = 'EOS:bystander';
const BYSTANDER_STEAM_ID = 'steam-bystander';

/**
 * @param {object} [opts]
 * @param {number} [opts.initialTeamID]
 * @param {string|null} [opts.steamID]
 * @param {string[]} [opts.rejects] - identifiers Squad's mock RCON refuses outright.
 * @param {object|null} [opts.bystander] - an extra roster entry, first in the
 *   list, whose name contains the target's name — reproduces the
 *   "Hunt"/"Hunty" substring-match bug when the name tier is reached.
 * @param {string|null} [opts.forceNameHit] - eosID of the roster entry the
 *   mock RCON should hit for a name-tier command regardless of substring
 *   logic — stands in for "the real game server's matcher disagreed with
 *   our pre-send heuristic", to exercise the after-the-fact revert path.
 */
function makeSwitchTeamPlugin({
  initialTeamID = 1,
  steamID = STEAM_ID,
  rejects = [],
  bystander = null,
  forceNameHit = null
} = {}) {
  const eosID = EOS_ID;
  const playerName = 'Hunt'; // deliberately a prefix of an unrelated "Hunty"

  const target = { eosID, steamID, name: playerName, teamID: initialTeamID };
  // Bystander listed first so a substring match against "Hunt" finds
  // "Hunty" before it finds the real target — matching Squad's own
  // first-match behaviour and reproducing the original bug faithfully.
  const roster = bystander ? [{ ...bystander }, target] : [target];

  const executeCalls = [];
  const rcon = {
    async execute(cmd) {
      executeCalls.push(cmd);
      const match = cmd.match(/^AdminForceTeamChange "(.*)"$/);
      const identifier = match ? match[1] : null;

      if (!identifier || rejects.includes(identifier)) {
        return `ERROR: Unable to find player with name or id (${identifier})`;
      }

      let hit = roster.find((p) => p.eosID === identifier || p.steamID === identifier);
      if (!hit && forceNameHit) {
        hit = roster.find((p) => p.eosID === forceNameHit);
      }
      if (!hit) {
        // Squad's real AdminForceTeamChange partial-matches a plain name
        // against every connected player — first match wins.
        hit = roster.find((p) => p.name.toLowerCase().includes(identifier.toLowerCase()));
      }
      if (!hit) {
        return `ERROR: Unable to find player with name or id (${identifier})`;
      }

      hit.teamID = hit.teamID === 1 ? 2 : 1;
      return `Forced team change for player. [Online IDs= EOS: ${hit.eosID}] ${hit.name}`;
    }
  };

  const players = {
    getPlayer: (id) => {
      const p = roster.find((p) => p.eosID === id || p.steamID === id);
      return p ? { ...p } : null;
    },
    getAllPlayers: () => roster.map((p) => ({ ...p })),
    refreshNow: async () => {},
    recordMove: () => {}
  };

  const plugin = new S3PluginBase({ rcon, plugins: [] }, {}, {});
  plugin._s3 = { players };

  return { plugin, eosID, steamID, playerName, executeCalls, roster };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  console.log('='.repeat(65));
  console.log('_requestTeamChange() RCON Argument Test');
  console.log('='.repeat(65));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${err.message.split('\n')[0]}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(65));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('─'.repeat(65));

  await fs.rm(SANDBOX, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('sends eosID first when the server accepts it', async () => {
  const { plugin, eosID, playerName, executeCalls } = makeSwitchTeamPlugin();

  await plugin._requestTeamChange(eosID, { maxAttempts: 1, source: 'TestSuite' });

  assert.equal(executeCalls.length, 1, 'rcon.execute should be called once');
  assert.equal(executeCalls[0], `AdminForceTeamChange "${eosID}"`, 'first (and only) call should use eosID');
  assert.ok(
    !executeCalls[0].includes(playerName),
    'must not send the ambiguous player name when eosID is accepted'
  );
});

test('cascades to steamID when the server rejects eosID', async () => {
  const { plugin, eosID, steamID, executeCalls } = makeSwitchTeamPlugin({ rejects: [EOS_ID] });

  const result = await plugin._requestTeamChange(eosID, { maxAttempts: 1, source: 'TestSuite' });

  assert.deepEqual(
    executeCalls,
    [`AdminForceTeamChange "${eosID}"`, `AdminForceTeamChange "${steamID}"`],
    'should try eosID, get rejected, then try steamID'
  );
  assert.equal(result.success, true, 'steamID acceptance should still verify as success');

  // eosRejectionWarned is module-scoped (warn once per process, not per
  // plugin instance) — this is necessarily the first test in file order to
  // reject eosID, so it's the one that observes the warning fire.
  assert.ok(
    plugin.logs.some((l) => l.startsWith('[v1]') && l.includes('WARNING') && l.includes('eosID')),
    'should log a one-time visible warning the first time eosID is rejected'
  );
});

test('cascades all the way to playerName when eosID and steamID are both rejected', async () => {
  const { plugin, eosID, steamID, playerName, executeCalls } = makeSwitchTeamPlugin({
    rejects: [EOS_ID, STEAM_ID]
  });

  const result = await plugin._requestTeamChange(eosID, { maxAttempts: 1, source: 'TestSuite' });

  assert.deepEqual(
    executeCalls,
    [
      `AdminForceTeamChange "${eosID}"`,
      `AdminForceTeamChange "${steamID}"`,
      `AdminForceTeamChange "${playerName}"`
    ],
    'should exhaust eosID and steamID before falling back to playerName'
  );
  assert.equal(result.success, true, 'playerName as last resort should still verify as success');
});

test('skips steamID tier entirely when the player has none', async () => {
  const { plugin, eosID, playerName, executeCalls } = makeSwitchTeamPlugin({
    steamID: null,
    rejects: [EOS_ID]
  });

  await plugin._requestTeamChange(eosID, { maxAttempts: 1, source: 'TestSuite' });

  assert.deepEqual(
    executeCalls,
    [`AdminForceTeamChange "${eosID}"`, `AdminForceTeamChange "${playerName}"`],
    'a null steamID should be skipped, not sent as the literal string "null"'
  );
});

test('always attempts eosID first — whether it works varies per player/connection, not SquadJS version', async () => {
  // There is no version-based gating: live testing showed the same eosID
  // rejected for a player on one server and accepted for the same player on
  // another, tracking with whether their connection had a populated
  // steamID rather than anything about the server build. eosID is always
  // tried first; the cascade absorbs a rejection if one comes back.
  const { plugin, eosID, executeCalls } = makeSwitchTeamPlugin();

  await plugin._requestTeamChange(eosID, { maxAttempts: 1, source: 'TestSuite' });

  assert.deepEqual(executeCalls, [`AdminForceTeamChange "${eosID}"`]);
});

test('refuses to send an ambiguous name-tier command at all, and does not report false success', async () => {
  // Reproduces the original Hunty bug directly: eosID/steamID for the real
  // target are both rejected on this connection, so the only remaining tier
  // is "Hunt" — and a bystander named "Hunty" is
  // also connected, exactly as in production. The fix is prevention, not
  // cleanup: the ambiguous command must never be sent in the first place.
  const { plugin, eosID, executeCalls, roster } = makeSwitchTeamPlugin({
    rejects: [EOS_ID, STEAM_ID],
    bystander: { eosID: BYSTANDER_EOS_ID, steamID: BYSTANDER_STEAM_ID, name: 'Hunty', teamID: 1 }
  });

  const result = await plugin._requestTeamChange(eosID, { maxAttempts: 1, source: 'TestSuite' });

  assert.ok(
    !executeCalls.some((c) => c.includes('"Hunt"')),
    'the ambiguous name command must never be sent — not sent-then-reverted, just never sent'
  );

  const bystander = roster.find((p) => p.name === 'Hunty');
  assert.equal(bystander.teamID, 1, 'bystander should never have moved at all');

  assert.equal(
    result.success,
    false,
    'no safe identifier was available — this must not be reported as success'
  );

  assert.ok(
    plugin.logs.some((l) => l.includes('WARNING') && l.toLowerCase().includes('collision')),
    'should log a warning identifying the collision and refusing to send'
  );
});

test('does not verify success when Squad matches a bystander the pre-send check could not have predicted', async () => {
  // There is deliberately no after-the-fact revert here (see the docblock
  // above _sendTeamChangeCommand): reverting requires diffing the roster
  // across an RCON round-trip, and that window is wide enough for an
  // unrelated legitimate team change (another admin, SmartAssign/
  // TeamBalancer, a player self-switching) to be mistaken for a collision
  // and undone. So if Squad's real matcher ever disagrees with the
  // pre-send _findNameCollision() heuristic, the wrong player's team just
  // stays flipped — the only guarantee is that the intended target's
  // change is never reported as verified, since verification reads the
  // target's own teamID, not the bystander's. Simulated here with a
  // bystander name ("Roamer") that does NOT textually collide with "Hunt"
  // — so _findNameCollision() finds nothing and lets the send through —
  // but the mock RCON is wired to hit that bystander anyway, standing in
  // for "the real game server matched something our heuristic didn't
  // predict".
  const { plugin, eosID, roster } = makeSwitchTeamPlugin({
    rejects: [EOS_ID, STEAM_ID],
    bystander: { eosID: BYSTANDER_EOS_ID, steamID: BYSTANDER_STEAM_ID, name: 'Roamer', teamID: 1 },
    forceNameHit: BYSTANDER_EOS_ID
  });

  const result = await plugin._requestTeamChange(eosID, { maxAttempts: 1, source: 'TestSuite' });

  assert.equal(result.success, false, 'the intended target never actually moved, so this must not verify as success');
});

test('does not touch bystanders when the name tier hits the correct player', async () => {
  const { plugin, eosID, roster } = makeSwitchTeamPlugin({
    rejects: [EOS_ID, STEAM_ID],
    bystander: { eosID: BYSTANDER_EOS_ID, steamID: BYSTANDER_STEAM_ID, name: 'Bystander', teamID: 1 }
  });

  const result = await plugin._requestTeamChange(eosID, { maxAttempts: 1, source: 'TestSuite' });

  const bystander = roster.find((p) => p.name === 'Bystander');
  assert.equal(bystander.teamID, 1, 'unrelated bystander should never move');
  assert.equal(result.success, true, 'the correctly-matched target should verify as success');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();
