/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   TEST: POST-SWITCH LOCKOUT — the real write/read path         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * The double-switch race: S³'s _requestTeamChange (s3-plugin-base.js)
 * calls recordMove() and flips the player registry's teamID BEFORE the
 * RCON round-trip and the player's client catch up. A player who assumes
 * their first !switch didn't register can fire a second one that reads
 * the already-flipped teamID and gets switched straight back, burning two
 * tokens for a net no-op.
 *
 * The fix is a 10s in-memory per-player lockout: _taggedSwitchPlayer()
 * records a timestamp in plugin.recentSwitches on every successful move
 * (any source), and _checkSwitchEligibility() — reached only by a
 * self-requested !switch — refuses while that timestamp is fresh.
 *
 * test-eligibility-check.js already covers this exhaustively against the
 * mock harness's hand-copied _checkSwitchEligibility. That copy is
 * maintained by hand and can drift from switch.js. This file instead
 * builds the shipped layout and exercises the real _taggedSwitchPlayer,
 * _checkSwitchEligibility, and handlePlayerLeave — the actual production
 * code, not a re-implementation of it.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-post-switch-lockout.js
 *
 * Category: 1 (no DB, no dialect-specific behaviour — the lockout gate
 * runs entirely in memory, before any model lookup).
 */

'use strict';

import assert from 'node:assert/strict';

import SwitchOutput from '../utils/switch-output.js';
import SwitchQueue from '../utils/switch-queue.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';

const ASSEMBLY = buildAssembly('.tmp-switch-post-lockout');
const Switch = await importFromAssembly(ASSEMBLY, 'switch.js');

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
    failed++;
  }
}

/**
 * A real Switch instance wired to an in-memory player registry, with RCON
 * replaced by a controllable stub. `_sendTeamChangeCommand` is the seam
 * s3-plugin-base.js's _requestTeamChange calls to actually move a player —
 * overriding it lets a test decide whether the "RCON round-trip" lands the
 * player on their target team, without a live Squad server.
 *
 * onSend(player, targetTeamID) runs on every attempt; returning nothing
 * (or a falsy ok) simulates a rejected/failed RCON call, so
 * _requestTeamChange exhausts its retries and _taggedSwitchPlayer throws.
 * The default flips the player onto their target team, simulating success.
 */
function buildPlugin({ players, onSend } = {}) {
  const registry = new Map(players.map((p) => [p.eosID, p]));

  const server = { players, on: () => {}, off: () => {}, removeListener: () => {} };
  const plugin = new Switch(server, {}, {});

  // handlePlayerLeave reaches into the queue/join-warn subsystems even
  // though this suite never enqueues anyone — register the real mixins so
  // it runs the shipped path rather than throwing on an unregistered method.
  SwitchOutput.register(plugin);
  SwitchQueue.register(plugin);

  Object.assign(plugin, {
    verbose: () => {},
    warn: () => {},
    // Eligibility beyond the recent_switch gate itself is out of scope here
    // (test-eligibility-check.js already covers cooldown/time_window/etc.
    // against the mock); this just needs to reach "eligible: true" cleanly
    // once the lockout clears, without wiring up getSecondsFromJoin's
    // isReady()/getJoinTime() dependencies.
    timeLimitEnabled: false,
    _s3: {
      players: {
        getPlayer: (eosID) => registry.get(eosID) || null,
        recordMove: () => {},
        refreshNow: async () => {}
      }
    },
    _sendTeamChangeCommand: async (player) => {
      const targetTeamID = player.teamID === 1 ? 2 : 1;
      const sent = onSend ? onSend(player, targetTeamID) : true;
      if (sent) {
        const state = registry.get(player.eosID);
        if (state) state.teamID = targetTeamID;
        return { ok: true, type: 'eosID', response: 'ok' };
      }
      return { ok: false, type: null, response: null };
    }
  });

  return { plugin, registry };
}

const P = (eosID, teamID, name) => ({ eosID, teamID, name: name || eosID });

console.log('');
console.log('🧪 Post-switch lockout — real write/read path');
console.log('');

// ── 1. A successful switch records the lockout ─────────────────────
await runTest('_taggedSwitchPlayer records recentSwitches on success', async () => {
  const { plugin } = buildPlugin({ players: [P('eos-a', 1, 'Alpha')] });

  assert.strictEqual(plugin.recentSwitches.length, 0, 'precondition: nothing recorded yet');
  const result = await plugin._taggedSwitchPlayer('eos-a', 'Switch-Self');

  assert.strictEqual(result.success, true, 'the simulated RCON move should succeed');
  assert.strictEqual(plugin.recentSwitches.length, 1, 'a recentSwitches entry should exist');
  assert.strictEqual(plugin.recentSwitches[0].eosID, 'eos-a');
  assert.ok(plugin.recentSwitches[0].datetime instanceof Date, 'entry should carry a real Date');
});

// ── 2. A failed switch throws AND does not record anything ─────────
await runTest('_taggedSwitchPlayer throws and records nothing when RCON never confirms', async () => {
  const { plugin } = buildPlugin({ players: [P('eos-a', 1, 'Alpha')], onSend: () => false });

  await assert.rejects(
    () => plugin._taggedSwitchPlayer('eos-a', 'Switch-Self'),
    /Team change failed/,
    'should throw after all attempts are exhausted'
  );
  assert.strictEqual(plugin.recentSwitches.length, 0, 'a failed move must not arm the lockout');
});

// ── 3. Real _checkSwitchEligibility denies right after a real switch ─
await runTest('_checkSwitchEligibility denies with recent_switch after a real recorded move', async () => {
  const { plugin } = buildPlugin({ players: [P('eos-a', 1, 'Alpha')] });

  await plugin._taggedSwitchPlayer('eos-a', 'Switch-Self');
  const result = await plugin._checkSwitchEligibility({ eosID: 'eos-a' });

  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reason, 'recent_switch');
  assert.ok(Number.isInteger(result.remaining) && result.remaining > 0 && result.remaining <= 10);
});

// ── 4. Backdating the real timestamp restores eligibility ──────────
// The real gate reads Date.now() directly (no injectable clock, unlike the
// mock harness), so the only way to test the boundary here is to backdate
// the recorded entry rather than fast-forward a fake clock.
await runTest('_checkSwitchEligibility is eligible again once the real timestamp ages out', async () => {
  const { plugin } = buildPlugin({ players: [P('eos-a', 1, 'Alpha')] });

  await plugin._taggedSwitchPlayer('eos-a', 'Switch-Self');
  plugin.recentSwitches[0].datetime = new Date(Date.now() - 10_001);

  const result = await plugin._checkSwitchEligibility({ eosID: 'eos-a' });
  assert.strictEqual(result.eligible, true, 'should be eligible once the 10s window has fully elapsed');
});

// ── 5. Two switches update the same entry, not a duplicate ─────────
await runTest('a second successful switch updates the existing entry in place', async () => {
  const { plugin } = buildPlugin({ players: [P('eos-a', 1, 'Alpha')] });

  await plugin._taggedSwitchPlayer('eos-a', 'Switch-Self');
  const firstStamp = plugin.recentSwitches[0].datetime.getTime();

  // Backdate so the second switch's timestamp is verifiably newer.
  plugin.recentSwitches[0].datetime = new Date(firstStamp - 5000);
  await plugin._taggedSwitchPlayer('eos-a', 'Switch-Self');

  assert.strictEqual(plugin.recentSwitches.length, 1, 'should still be exactly one entry for this player');
  assert.ok(
    plugin.recentSwitches[0].datetime.getTime() > firstStamp - 5000,
    'the entry should reflect the more recent switch, not the first one'
  );
});

// ── 6. handlePlayerLeave clears the lockout on disconnect ───────────
await runTest('handlePlayerLeave clears recentSwitches, restoring eligibility within the window', async () => {
  const { plugin } = buildPlugin({ players: [P('eos-a', 1, 'Alpha')] });

  await plugin._taggedSwitchPlayer('eos-a', 'Switch-Self');
  assert.strictEqual(plugin.recentSwitches.length, 1, 'precondition: lockout armed');

  plugin.handlePlayerLeave('eos-a', 2, 'Alpha');

  assert.strictEqual(plugin.recentSwitches.length, 0, 'disconnect should clear the entry');
  const result = await plugin._checkSwitchEligibility({ eosID: 'eos-a' });
  assert.strictEqual(result.eligible, true, 'eligibility should be restored immediately, still inside the 10s window');
});

// ── 7. Lockout is scoped per player (real code path) ────────────────
await runTest('one player\'s lockout does not block a different player', async () => {
  const { plugin } = buildPlugin({
    players: [P('eos-a', 1, 'Alpha'), P('eos-b', 2, 'Bravo')]
  });

  await plugin._taggedSwitchPlayer('eos-a', 'Switch-Self');
  const result = await plugin._checkSwitchEligibility({ eosID: 'eos-b' });

  assert.strictEqual(result.eligible, true, 'eos-b should be unaffected by eos-a\'s lockout');
  assert.strictEqual(plugin.recentSwitches.length, 1, 'only eos-a should have an entry');
});

// ── 8. Unknown eosID: no crash, no bogus recording ──────────────────
await runTest('_taggedSwitchPlayer returns null and records nothing for an unknown eosID', async () => {
  const { plugin } = buildPlugin({ players: [P('eos-a', 1, 'Alpha')] });

  const result = await plugin._taggedSwitchPlayer('eos-ghost', 'Switch-Self');

  assert.strictEqual(result, null, 'a player absent from the S³ registry should resolve to null');
  assert.strictEqual(plugin.recentSwitches.length, 0, 'nothing should be recorded for a player that was never found');
});

// ── 9. Admin-forced switch arms the lockout that blocks a self-request ─
// The scenario the user reported: an admin swaps someone right as they hit
// !switch. The admin move (any source) must still arm the same gate a
// self-request checks, or the race just reopens from the other direction.
await runTest('an Admin-Force switch still arms the lockout a self-request is gated on', async () => {
  const { plugin } = buildPlugin({ players: [P('eos-a', 1, 'Alpha')] });

  await plugin._taggedSwitchPlayer('eos-a', 'Admin-Force');
  const result = await plugin._checkSwitchEligibility({ eosID: 'eos-a' });

  assert.strictEqual(result.eligible, false, 'a same-player self-request must be blocked regardless of switch source');
  assert.strictEqual(result.reason, 'recent_switch');
});

console.log('');
console.log(`📊 Results: ${passed}/${passed + failed} passed, ${failed} failed`);
console.log('');

cleanAssembly(ASSEMBLY);
if (failed > 0) process.exitCode = 1;
