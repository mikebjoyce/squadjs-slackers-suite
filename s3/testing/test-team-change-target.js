/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   TEAM CHANGE TARGETS — moves that survive Squad party drags  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Since Squad's October 2026 party patch, force-moving a party's leader
 * drags the whole party to the leader's new team. _requestTeamChange()
 * used to compute its target as "the team opposite the one the player is
 * on now", so when a scramble reached a mate the leader had already
 * dragged, it moved them straight back — every failed scramble move on
 * the live server after the patch had that shape.
 *
 * This loads the real shipped files (via plugin-assembly) and runs them
 * against a fake RCON that implements the drag (fake-party-rcon.js):
 *
 *   - _requestTeamChange() with options.targetTeamID: a player already on
 *     the target costs no command; bad targets are refused; no target
 *     keeps the old toggle;
 *   - TeamBalancer's SwapExecutor passes each move's planned target, so a
 *     party ends together whichever member the plan reaches first;
 *   - Switch's own move paths pass explicit targets (squad switch, double
 *     switch).
 *
 * Category: 2 (sandboxed real-file import, no live server)
 * Run:    node s3/testing/test-team-change-target.js
 */

'use strict';

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAssembly, importFromAssembly, cleanAssembly } from './plugin-assembly.js';
import { createPartyWorld } from './fake-party-rcon.js';

const ASSEMBLY = buildAssembly('.tmp-team-change-target');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

try {
  const S3PluginBase = await importFromAssembly(ASSEMBLY, 's3-plugin-base.js');
  const Switch = await importFromAssembly(ASSEMBLY, 'switch.js');
  const { default: SwapExecutor } = await import(
    pathToFileURL(path.join(ASSEMBLY, 'utils', 'tb-swap-executor.js')).href
  );

  // A plugin instance without its constructor: only the fields
  // _requestTeamChange() and the Switch move paths read are wired up.
  function attach(Klass, world, extra = {}) {
    const plugin = Object.create(Klass.prototype);
    plugin.server = { rcon: world.rcon, players: world.roster };
    plugin._s3 = { players: world.players };
    plugin.logs = [];
    plugin.verbose = (level, message) => plugin.logs.push(`[v${level}] ${message}`);
    plugin.localize = (key) => key;
    plugin.warn = () => {};
    Object.assign(plugin, extra);
    return plugin;
  }

  // A two-player party on T1: L leads, M is a member.
  function pair(opts = {}) {
    return createPartyWorld([
      { eosID: 'L', name: 'Leader', teamID: 1, squadID: 1, party: 'A', leader: true, dragsBothWays: !!opts.bothWays },
      { eosID: 'M', name: 'Member', teamID: 1, squadID: 1, party: 'A', dragsBothWays: !!opts.bothWays },
      { eosID: 'S', name: 'Solo', teamID: 2, squadID: 3 }
    ]);
  }

  // ── _requestTeamChange ──────────────────────────────────────────

  test('a player already on the target team costs no command', async () => {
    const world = pair();
    const plugin = attach(S3PluginBase, world);
    const result = await plugin._requestTeamChange('S', { targetTeamID: 2, maxAttempts: 3 });
    assert.equal(result.success, true);
    assert.equal(result.teamID, 2);
    assert.equal(result.attempts, 0);
    assert.deepEqual(world.commands, []);
  });

  test('a player on the other team is moved to the target', async () => {
    const world = pair();
    const plugin = attach(S3PluginBase, world);
    const result = await plugin._requestTeamChange('S', { targetTeamID: 1, maxAttempts: 3 });
    assert.equal(result.success, true);
    assert.equal(world.teamOf('S'), 1);
    assert.deepEqual(world.commands, ['S']);
  });

  test('a target that is not 1 or 2 is refused without a command', async () => {
    for (const bad of [0, 3, 'x', -1]) {
      const world = pair();
      const plugin = attach(S3PluginBase, world);
      const result = await plugin._requestTeamChange('S', { targetTeamID: bad, maxAttempts: 3 });
      assert.equal(result, null, `targetTeamID ${bad} should be refused`);
      assert.deepEqual(world.commands, []);
      assert.ok(plugin.logs.some((l) => l.startsWith('[v1]') && l.includes('Invalid targetTeamID')));
    }
  });

  test('a numeric-string target is accepted', async () => {
    const world = pair();
    const plugin = attach(S3PluginBase, world);
    const result = await plugin._requestTeamChange('S', { targetTeamID: '1', maxAttempts: 3 });
    assert.equal(result.success, true);
    assert.equal(world.teamOf('S'), 1);
  });

  test('no target keeps the old toggle and says so at level 2', async () => {
    const world = pair();
    const plugin = attach(S3PluginBase, world);
    const result = await plugin._requestTeamChange('S', { maxAttempts: 3 });
    assert.equal(result.success, true);
    assert.equal(world.teamOf('S'), 1);
    assert.ok(plugin.logs.some((l) => l.startsWith('[v2]') && l.includes('No targetTeamID')));
  });

  test('without targets, a dragged mate is sent back (the bug this fixes)', async () => {
    const world = pair();
    const plugin = attach(S3PluginBase, world);
    await plugin._requestTeamChange('L', { maxAttempts: 3 });
    assert.equal(world.teamOf('M'), 2, 'the leader drags the member');
    await plugin._requestTeamChange('M', { maxAttempts: 3 });
    assert.equal(world.teamOf('M'), 1, 'the toggle sends the member back: the party is split');
  });

  test('leader first: the member is already there and costs nothing', async () => {
    const world = pair();
    const plugin = attach(S3PluginBase, world);
    await plugin._requestTeamChange('L', { targetTeamID: 2, maxAttempts: 3 });
    const member = await plugin._requestTeamChange('M', { targetTeamID: 2, maxAttempts: 3 });
    assert.equal(member.success, true);
    assert.equal(world.teamOf('L'), 2);
    assert.equal(world.teamOf('M'), 2);
    assert.deepEqual(world.commands, ['L']);
  });

  test('member first: the leader\'s move leaves the member where they are', async () => {
    const world = pair();
    const plugin = attach(S3PluginBase, world);
    await plugin._requestTeamChange('M', { targetTeamID: 2, maxAttempts: 3 });
    assert.equal(world.teamOf('L'), 1, 'a member moves alone');
    await plugin._requestTeamChange('L', { targetTeamID: 2, maxAttempts: 3 });
    assert.equal(world.teamOf('L'), 2);
    assert.equal(world.teamOf('M'), 2);
    assert.deepEqual(world.commands, ['M', 'L']);
  });

  test('a party where either member drags both still ends together', async () => {
    const world = pair({ bothWays: true });
    const plugin = attach(S3PluginBase, world);
    await plugin._requestTeamChange('M', { targetTeamID: 2, maxAttempts: 3 });
    await plugin._requestTeamChange('L', { targetTeamID: 2, maxAttempts: 3 });
    assert.equal(world.teamOf('L'), 2);
    assert.equal(world.teamOf('M'), 2);
    assert.deepEqual(world.commands, ['M']);
  });

  test('a refused move still fails after its attempts', async () => {
    const world = pair();
    world.refuse = true;
    const plugin = attach(S3PluginBase, world);
    const result = await plugin._requestTeamChange('S', { targetTeamID: 1, maxAttempts: 3 });
    assert.equal(result.success, false);
    assert.equal(world.commands.length, 3);
  });

  // ── TeamBalancer's SwapExecutor ─────────────────────────────────

  async function runScramble(world, plan) {
    const base = attach(S3PluginBase, world);
    const teamBalancer = { _s3: { players: world.players }, _pendingScrambleType: 'Full' };
    const executor = new SwapExecutor(
      { players: world.roster },
      { changeTeamRetryInterval: 10, maxScrambleCompletionTime: 3000 },
      {},
      teamBalancer,
      base._requestTeamChange.bind(base)
    );
    for (const [eosID, target] of plan) await executor.queueMove(eosID, target);
    const deadline = Date.now() + 3000;
    while (!executor.getLastSessionReport?.() && !executor._lastSessionReport && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return executor._lastSessionReport;
  }

  test('scramble reaching the leader first: no failures, party together', async () => {
    const world = pair();
    const report = await runScramble(world, [['L', 2], ['M', 2], ['S', 1]]);
    assert.ok(report, 'the session should complete');
    assert.equal(report.failedToMove, 0);
    assert.equal(world.teamOf('L'), 2);
    assert.equal(world.teamOf('M'), 2);
    assert.equal(world.teamOf('S'), 1);
    assert.deepEqual(world.commands, ['L', 'S']);
  });

  test('scramble reaching the member first: no failures, party together', async () => {
    const world = pair();
    const report = await runScramble(world, [['M', 2], ['L', 2]]);
    assert.equal(report.failedToMove, 0);
    assert.equal(world.teamOf('L'), 2);
    assert.equal(world.teamOf('M'), 2);
  });

  test('scramble with a party that drags both ways: no failures', async () => {
    const world = pair({ bothWays: true });
    const report = await runScramble(world, [['L', 2], ['M', 2]]);
    assert.equal(report.failedToMove, 0);
    assert.deepEqual(world.commands, ['L']);
  });

  // ── Switch move paths ───────────────────────────────────────────

  function switchOn(world) {
    return attach(Switch, world, {
      options: { doubleSwitchDelaySeconds: 0, doubleSwitchEnabledMinutes: 999, doubleSwitchCooldownHours: 0 },
      recentDoubleSwitches: [],
      _recordRecentSwitch: () => {}
    });
  }

  test('switchSquad moves a squad holding a party without splitting it', async () => {
    const world = pair();
    const plugin = switchOn(world);
    await plugin.switchSquad(1, 1);
    assert.equal(world.teamOf('L'), 2);
    assert.equal(world.teamOf('M'), 2);
  });

  test('double switch of a party leader brings the party back where it started', async () => {
    const world = pair();
    const plugin = switchOn(world);
    await plugin.doubleSwitchPlayer('L', true);
    assert.equal(world.teamOf('L'), 1);
    assert.equal(world.teamOf('M'), 1);
  });

  test('double switch of a solo player ends on their own team', async () => {
    const world = pair();
    const plugin = switchOn(world);
    await plugin.doubleSwitchPlayer('S', true);
    assert.equal(world.teamOf('S'), 2);
    assert.deepEqual(world.commands, ['S', 'S']);
  });

  test('doubleSwitchSquad brings a squad holding a party back where it started', async () => {
    const world = pair();
    const plugin = switchOn(world);
    await plugin.doubleSwitchSquad(1, 1);
    assert.equal(world.teamOf('L'), 1);
    assert.equal(world.teamOf('M'), 1);
  });

  test('_taggedSwitchPlayer passes its target through', async () => {
    const world = pair();
    const plugin = switchOn(world);
    const result = await plugin._taggedSwitchPlayer('S', 'Test', 2);
    assert.equal(result.success, true);
    assert.deepEqual(world.commands, [], 'already on T2, so no command');
  });

  console.log('='.repeat(65));
  console.log('Team Change Target Test');
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
} finally {
  cleanAssembly(ASSEMBLY);
}

if (failed > 0) process.exitCode = 1;
