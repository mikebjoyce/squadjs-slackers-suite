/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          PLUGIN LOGIC TEST RUNNER                            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Tests core plugin logic independent of the scramble algorithm:
 * streak tracking, scramble trigger conditions, mode detection,
 * and configuration option validation.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/plugin-logic-test-runner.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - No running SquadJS server required; server, RCON and DB are mocked.
 *   (The note claiming otherwise was wrong — nothing here touches a live
 *   server, and it would not have run against one either: see below.)
 * - team-balancer.js imports './s3-plugin-base.js', a sibling only in the
 *   flattened layout install.cjs produces. Importing the plugin straight
 *   from ../plugins/ threw ERR_MODULE_NOT_FOUND, so this file died on load
 *   and every assertion in it had been dead for as long as that import has
 *   been there. It now loads out of a throwaway assembly instead.
 * - Monorepo-only: reaching into ../../s3/ does not resolve at a deployed
 *   target, where every plugin shares one flat directory.
 *
 */

import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { makeMockS3, makeS3Db } from '../../s3/testing/mock-s3.js';
import Logger from '../../core/logger.js'; // The plugin uses this, so we need a mock.

const assembly = buildAssembly('.tmp-tb-plugin-logic');
const TeamBalancer = await importFromAssembly(assembly, 'team-balancer.js');

// Suppress logger output for cleaner test results
Logger.verbose = (module, level, message) => {
  if (level === 1) console.error(`[${module}] ERROR: ${message}`);
};

console.log('🧪 Initializing Plugin Logic Test Harness...');

// 1. Environment Initialization (The "Harness")
const capturedBroadcasts = [];
const mockServer = {
  rcon: {
    broadcast: async (msg) => {
      capturedBroadcasts.push(msg);
    },
    execute: async (cmd) => {},
    warn: async (steamID, msg) => {},
    switchTeam: async (rconIdentifier, teamID) => {
      // Actually mutate the mock player so SwapExecutor's verification step sees the move succeed.
      const player = mockServer.players.find(
        (p) => p.steamID === rconIdentifier || p.name === rconIdentifier || p.eosID === rconIdentifier
      );
      if (player) player.teamID = Number(teamID);
    },
  },
  players: [], // empty for logic tests
  squads: [], // empty for logic tests
  currentLayer: null,
  // S3PluginBase discovers S³ here, by constructor name, and the plugin then
  // gates itself on its version. Without this, mount() throws before the first
  // assertion.
  //
  // The S³ carries a REAL DBService over in-memory SQLite. Streak state lives
  // in the database — winStreakCount is read back through this.db on every
  // round — so a null DB makes every streak assertion below read 0 regardless
  // of what the plugin computed. The mockConnectors object further down is a
  // leftover from when this plugin owned its own connector; the plugin now
  // takes its DB from S³, and that object is no longer reached.
  plugins: [makeMockS3({ db: await makeS3Db() })],
  // Mock listener methods to prevent errors
  removeListener: () => {},
  on: () => {},
  listenerCount: () => 0,
  emit: () => {}, // executeScramble() emits TEAM_BALANCER_SCRAMBLE_EXECUTED
  updatePlayerList: async () => {}, // SwapExecutor refreshes the player list to verify moves
};

const mockDbState = {
  winStreakTeam: null,
  winStreakCount: 0,
  consecutiveWinsTeam: null,
  consecutiveWinsCount: 0,
  lastSyncTimestamp: Date.now(),
  lastScrambleTime: null,
};

const mockModel = {
  sync: async () => {},
  findOrCreate: async () => {
    const instance = {
      ...mockDbState,
      save: async function () {
        mockDbState.winStreakTeam = this.winStreakTeam;
        mockDbState.winStreakCount = this.winStreakCount;
        mockDbState.consecutiveWinsTeam = this.consecutiveWinsTeam;
        mockDbState.consecutiveWinsCount = this.consecutiveWinsCount;
        mockDbState.lastSyncTimestamp = this.lastSyncTimestamp;
        mockDbState.lastScrambleTime = this.lastScrambleTime;
      },
    };
    return [instance, true];
  },
  findByPk: async () => {
    const instance = {
      ...mockDbState,
      save: async function () {
        mockDbState.winStreakTeam = this.winStreakTeam;
        mockDbState.winStreakCount = this.winStreakCount;
        mockDbState.consecutiveWinsTeam = this.consecutiveWinsTeam;
        mockDbState.consecutiveWinsCount = this.consecutiveWinsCount;
        mockDbState.lastSyncTimestamp = this.lastSyncTimestamp;
        mockDbState.lastScrambleTime = this.lastScrambleTime;
      },
    };
    return instance;
  },
};

const mockConnectors = {
  // Mock the database connector to prevent file system access and errors
  sqlite: {
    define: () => mockModel,
    transaction: async (fn) => {
      // Execute the callback immediately with a dummy transaction object
      return fn({
        commit: async () => {},
        rollback: async () => {},
        LOCK: { UPDATE: 'UPDATE' },
      });
    },
    query: async () => [], // tb-database initDB issues PRAGMA journal_mode=WAL etc.
  },
};

const defaultTestOptions = {
  database: 'sqlite',
  enableWinStreakTracking: true,
  maxWinStreak: 2,
  maxConsecutiveWinsWithoutThreshold: 3,
  enableSingleRoundScramble: false,
  singleRoundScrambleThreshold: 500,
  minTicketsToCountAsDominantWin: 300,
  invasionAttackTeamThreshold: 300,
  invasionDefenceTeamThreshold: 650,
  // Both null, matching the shipped defaults: TC starts out untuned and on the
  // standard scale, which is the state the first TC cases below assert.
  tcDominantThreshold: null,
  tcSingleRoundScrambleThreshold: null,
  scrambleAnnouncementDelay: 10,
  scramblePercentage: 0.5,
  showWinStreakMessages: true,
  debugLogs: false,
  devMode: true, // To simplify command handling if needed
  useGenericTeamNamesInBroadcasts: true, // For predictable broadcast messages
  changeTeamRetryInterval: 150,
  maxScrambleCompletionTime: 5000,
  warnOnSwap: false,
  discordClient: null,
  discordAdminChannelID: null,
  discordReportChannelID: null,
  discordAdminRoleIDs: [],
};

// Helper for asserting test conditions
let testCount = 0;
let passCount = 0;
function assert(condition, message) {
  testCount++;
  if (condition) {
    passCount++;
    console.log(`  ✅ PASS: ${message}`);
  } else {
    console.log(`  ❌ FAIL: ${message}`);
  }
}

async function runPluginLogicTests() {
  console.log('\n🚀 Starting Plugin Logic Tests...');

  // Instantiate the plugin with our mock environment
  const tb = new TeamBalancer(mockServer, { ...defaultTestOptions }, mockConnectors);

  // Mock RconMessages and formatMessage as BasePlugin loading is bypassed/incomplete in test harness
  tb.RconMessages = {
    prefix: '[TB]',
    executeScrambleMessage: 'Scrambling teams!',
    executeDryRunMessage: 'Dry run scramble!',
    scrambleCompleteMessage: 'Scramble complete.',
    scrambleFailedMessage: 'Scramble failed.',
    manualScrambleAnnouncement: 'Manual scramble in {delay}s',
    immediateManualScramble: 'Scrambling now!',
    scrambleAnnouncement: 'Scramble in {delay}s after {count} dominant wins',
    singleRoundScramble: 'Single round scramble triggered.',
    consecutiveWinsScramble: '{team} has won {count} consecutive rounds | Scrambling in {delay}s...',
    system: { trackingEnabled: 'Tracking enabled', trackingDisabled: 'Tracking disabled' },
    dominant: { stomped: 'Stomp', steamrolled: 'Steamrolled', invasionAttackStomp: 'Atk Stomp', invasionDefendStomp: 'Def Stomp' },
    nonDominant: { streakBroken: 'Streak Broken', invasionAttackWin: 'Atk Win', invasionDefendWin: 'Def Win', narrowVictory: 'Narrow', marginalVictory: 'Marginal', tacticalAdvantage: 'Tactical', operationalSuperiority: 'Operational' }
  };
  tb.formatMessage = (msg, params) => {
    if (!msg) return '';
    return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), msg);
  };

  // Manually mount to initialize DB stubs etc.
  // prepareToMount() is where S3PluginBase discovers S³; mount() does not call
  // it, so skipping it leaves _s3 undefined and the version gate reports
  // "got unknown".
  await tb.prepareToMount();
  await tb.mount();

  // Drive the gamemode the way production does — through S³. Assigning
  // tb.gameModeCached directly used to look equivalent, but onRoundEnded()
  // reads `this._s3.gameState.getGamemode()`, not the mirror, so every
  // "Invasion" case below was silently evaluated against the RAAS thresholds:
  // the 500-ticket defender win scored as dominant (>= 300) instead of falling
  // short of the 650 defender threshold. Emitting through the mock updates the
  // service AND the plugin's mirror, so both stay honest.
  const mockS3 = mockServer.plugins[0];
  // 'Territory Control', not 'TC': that is the exact string SquadJS's Layer
  // object carries and therefore what getGamemode() returns in production
  // (confirmed live on Logar_TC_v1 / Narva_TC_v1). Emitting the short name here
  // would test a spelling the plugin never actually sees, and would hide the
  // fact that the branch has to go through getGamemodeKey() to match.
  const LAYER_FOR_MODE = {
    RAAS: 'Fallujah_RAAS_v2',
    Invasion: 'Narva_Invasion_v1',
    'Territory Control': 'Logar_TC_v1'
  };
  const setGameMode = (mode) => mockS3.emitLayerGameModeChange(LAYER_FOR_MODE[mode] || 'Unknown', mode);

  // --- Phase 3.1: Layer & Mode Detection ---
  console.log('\n[Phase 3.1: Layer & Mode Detection]');
  setGameMode('RAAS');
  assert(tb.gameModeCached.includes('RAAS'), 'Game mode is correctly set to Standard (RAAS)');
  setGameMode('Invasion');
  assert(tb.gameModeCached.includes('Invasion'), 'Game mode is correctly set to Invasion');

  // --- Phase 3.2: The "Dominant Win" Matrix ---
  console.log('\n[Phase 3.2: The "Dominant Win" Matrix]');

  // Standard (Threshold 300): Win -> True
  await tb.resetStreak();
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 301 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Standard Dominant Win (301 tickets) correctly increments streak.');

  // Standard (Threshold 300): Loss -> False
  await tb.resetStreak();
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 150 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 0, 'Standard Non-Dominant Win (150 tickets) does NOT increment streak.');

  // Invasion Attacker (Threshold 300): Win -> True
  await tb.resetStreak();
  setGameMode('Invasion');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 350 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Invasion Attacker Dominant Win (350 tickets) correctly increments streak.');

  // Invasion Defender (Threshold 650): Loss -> False
  await tb.resetStreak();
  setGameMode('Invasion');
  await tb.onRoundEnded({ winner: { team: 2, tickets: 500 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 0, 'Invasion Defender Non-Dominant Win (500 tickets) does NOT increment streak.');

  // Invasion Defender (Threshold 650): Win -> True
  await tb.resetStreak();
  setGameMode('Invasion');
  await tb.onRoundEnded({ winner: { team: 2, tickets: 700 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Invasion Defender Dominant Win (700 tickets) correctly increments streak.');

  // --- Phase 3.2b: Territory Control ---
  //
  // TC used to be judged as RAAS/AAS because the only gamemode branch in
  // onRoundEnded was `isInvasion`. It now has its own options — but they
  // default to null, so the first pair below pins the deliberate no-op: an
  // untuned TC server stays on the RAAS/AAS scale.
  console.log('\n[Phase 3.2b: Territory Control]');

  // Untuned TC falls back to the standard 300 threshold, on both sides.
  await tb.resetStreak();
  setGameMode('Territory Control');
  assert(tb.gameModeCached === 'Territory Control', 'TC mirrors the full SquadJS spelling, not the short key.');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 301 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Untuned TC Dominant Win (301 tickets) uses the standard threshold.');

  await tb.resetStreak();
  setGameMode('Territory Control');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 150 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 0, 'Untuned TC Non-Dominant Win (150 tickets) uses the standard threshold.');

  // Tuned: 350 clears the standard 300 but not a TC-specific 500. If the mode
  // branch is not reached — the failure mode this whole change exists to fix —
  // this scores dominant and the streak increments.
  await tb.resetStreak();
  tb.options.tcDominantThreshold = 500;
  setGameMode('Territory Control');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 350 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 0, 'Tuned TC (500) rejects a 350-ticket win the standard scale would accept.');

  await tb.resetStreak();
  setGameMode('Territory Control');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 550 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Tuned TC (500) accepts a 550-ticket win.');

  // TC is symmetric: unlike Invasion, team 2 is judged on the same number as
  // team 1. A copy-paste of the Invasion arm would give team 2 its own scale.
  await tb.resetStreak();
  setGameMode('Territory Control');
  await tb.onRoundEnded({ winner: { team: 2, tickets: 550 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Tuned TC treats team 2 on the same scale as team 1 (symmetric mode).');

  // The TC threshold must not leak into other modes.
  await tb.resetStreak();
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 350 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'tcDominantThreshold does not affect RAAS.');
  tb.options.tcDominantThreshold = null;

  // Mercy scramble: TC gets its own margin, and again must not leak sideways.
  await tb.resetStreak();
  tb.options.enableSingleRoundScramble = true;
  tb.options.singleRoundScrambleThreshold = 500;
  tb.options.tcSingleRoundScrambleThreshold = 800;
  setGameMode('Territory Control');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 600 }, loser: { tickets: 0 } });
  assert(tb._scramblePending === false, 'TC mercy threshold (800) holds a 600-margin round the standard 500 would scramble.');

  await tb.resetStreak();
  setGameMode('Territory Control');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 850 }, loser: { tickets: 0 } });
  assert(tb._scramblePending === true, 'TC mercy threshold (800) scrambles an 850-margin round.');
  await tb.cancelPendingScramble(null, null, true);

  await tb.resetStreak();
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 600 }, loser: { tickets: 0 } });
  assert(tb._scramblePending === true, 'tcSingleRoundScrambleThreshold does not affect RAAS.');
  await tb.cancelPendingScramble(null, null, true);
  tb.options.tcSingleRoundScrambleThreshold = null;
  tb.options.enableSingleRoundScramble = false;

  // --- Phase 3.3: Streak & Scramble Triggering ---
  console.log('\n[Phase 3.3: Streak & Scramble Triggering]');

  // Sequence 1: Two dominant wins trigger scramble
  await tb.resetStreak();
  tb.options.maxWinStreak = 2;
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 400 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Sequence 1.1: First dominant win sets streak to 1.');
  assert(tb._scramblePending === false, 'Sequence 1.1: Scramble is NOT pending after first win.');

  await tb.onRoundEnded({ winner: { team: 1, tickets: 400 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 2, 'Sequence 1.2: Second dominant win sets streak to 2.');
  assert(tb._scramblePending === true, 'Sequence 1.2: Scramble IS pending after second win.');
  await tb.cancelPendingScramble(null, null, true); // Clean up for next test

  // Sequence 2: Streak Breaker
  await tb.resetStreak();
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 400 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Sequence 2.1: First dominant win sets streak to 1.');

  await tb.onRoundEnded({ winner: { team: 2, tickets: 50 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 0, 'Sequence 2.2: Non-dominant win by other team resets streak to 0.');

  // Sequence 3: Single Round Trigger
  await tb.resetStreak();
  tb.options.enableSingleRoundScramble = true;
  tb.options.singleRoundScrambleThreshold = 500;
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 600 }, loser: { tickets: 99 } }); // Margin 501
  assert(tb._scramblePending === true, 'Sequence 3: Single round scramble is triggered by massive ticket margin.');
  await tb.cancelPendingScramble(null, null, true); // Clean up
  tb.options.enableSingleRoundScramble = false; // Reset option

  // --- Phase 3.4: Announcement & Post-Scramble Reset ---
  console.log('\n[Phase 3.4: Announcement & Post-Scramble Reset]');

  // Test scramble announcement
  await tb.resetStreak();
  capturedBroadcasts.length = 0; // Clear broadcast history
  tb.options.maxWinStreak = 1;
  await tb.onRoundEnded({ winner: { team: 1, tickets: 400 }, loser: { tickets: 0 } });
  const announcement = capturedBroadcasts.find((msg) => msg.includes('Scramble in'));
  assert(!!announcement, 'Scramble announcement broadcast was captured.');
  if (announcement) {
    assert(announcement.includes('1 dominant wins'), 'Announcement includes correct win count.');
  }

  // Test post-scramble reset
  // We can call executeScramble directly to test the reset logic.
  // Populate server with unbalanced teams to ensure scramble generates moves and triggers the success path.
  // Note: transformSquadJSData filters out players without eosID, so each mock player needs one.
  // Also need players on BOTH teams (heavily imbalanced) so the scrambler has somewhere to swap to.
  tb.server.players = [
    ...Array.from({ length: 9 }, (_, i) => ({
      eosID: `mock_eos_t1_${i}`,
      steamID: `765611980000000${i}`,
      name: `T1Player${i}`,
      teamID: 1,
      squadID: null,
      roles: ['Rifleman']
    })),
    {
      eosID: 'mock_eos_t2_0',
      steamID: '76561198000000099',
      name: 'T2Player0',
      teamID: 2,
      squadID: null,
      roles: ['Rifleman']
    }
  ];
  // executeScramble() prefers S³'s roster over server.players whenever
  // players.getAllPlayers exists — which it always does now. Populating only
  // server.players left the scrambler with an empty roster, so it produced no
  // moves, took the early-out, and never reached the streak reset. Feed both.
  mockS3.state.players = tb.server.players;
  mockS3.state.squads = [];

  await tb.executeScramble(false); // isSimulated = false
  assert(tb.winStreakCount === 0, 'executeScramble resets the win streak count to 0.');
  assert(tb._scrambleInProgress === false, 'Scramble is no longer in progress after execution.');

  // --- Phase 3.6: NEW_GAME discards a pending scramble countdown ---
  console.log('\n[Phase 3.6: NEW_GAME discards a pending countdown]');

  // A countdown armed in the previous round must not fire into the new one: at NEW_GAME the teams are
  // freshly assigned (and teamIDs stay null for 30-60s), so it would scramble the wrong round.
  // The timer, not _scramblePending, has to drive the cleanup: resetStreak() clears that flag on its
  // own right after the seed/streak paths arm the countdown, so the flag is already false here.
  await tb.resetStreak();
  tb._scramblePending = false;
  tb._scrambleInProgress = false;
  tb.options.scrambleAnnouncementDelay = 0.05; // 50ms countdown, fires while this test is still running
  let countdownExecutions = 0;
  tb.executeScramble = async () => {
    countdownExecutions++;
    return true;
  };
  await tb.initiateScramble(false, false);
  assert(!!tb._scrambleCountdownTimeout, 'newgame: initiateScramble arms a countdown timer.');
  tb._scramblePending = false; // as resetStreak() does while the countdown is still armed
  await tb.onNewGame({ layer: { gamemode: 'RAAS', name: 'Yehorivka_RAAS_v1' } });
  assert(!tb._scrambleCountdownTimeout, 'newgame: the pending countdown timer is cleared at NEW_GAME.');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(countdownExecutions === 0, 'newgame: a countdown from the previous round does not execute in the new round.');
  delete tb.executeScramble;
  tb.options.scrambleAnnouncementDelay = defaultTestOptions.scrambleAnnouncementDelay;
  clearTimeout(tb._abbreviationPollStartTimeout); // onNewGame schedules abbreviation polling 5 min out

  // --- Phase 3.7: Consecutive Wins Tracking ---
  console.log('\n[Phase 3.7: Consecutive Wins Tracking]');

  // Consecutive wins increment for every non-ignored win regardless of margin
  await tb.resetStreak();
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } }); // Non-dominant margin
  assert(tb.consecutiveWinsCount === 1, 'Consecutive: Non-dominant win increments consecutive count to 1.');
  assert(tb.consecutiveWinsTeam === 1, 'Consecutive: Team 1 is tracked as consecutive winner.');
  assert(tb.winStreakCount === 0, 'Consecutive: Dominant streak is NOT incremented for non-dominant win.');

  await tb.onRoundEnded({ winner: { team: 1, tickets: 400 }, loser: { tickets: 0 } }); // Dominant margin
  assert(tb.consecutiveWinsCount === 2, 'Consecutive: Dominant win by same team increments consecutive count to 2.');
  assert(tb.winStreakCount === 1, 'Consecutive: Dominant streak IS incremented for dominant win.');

  // Consecutive wins reset when a different team wins
  await tb.onRoundEnded({ winner: { team: 2, tickets: 50 }, loser: { tickets: 0 } });
  assert(tb.consecutiveWinsCount === 1, 'Consecutive: Different team win resets consecutive count to 1.');
  assert(tb.consecutiveWinsTeam === 2, 'Consecutive: Team 2 is now the consecutive winner.');
  assert(tb.winStreakCount === 0, 'Consecutive: Dominant streak reset by non-dominant opposing win.');

  // Consecutive wins scramble trigger
  // The 400-ticket dominant win above armed a scramble, and resetStreak() only
  // clears the streak counters — not the arm. Leaving it set made the very next
  // assertion ("no scramble after 1 of 2") read a stale flag and fail.
  await tb.cancelPendingScramble(null, null, true);
  await tb.resetStreak();
  tb.options.maxConsecutiveWinsWithoutThreshold = 2;
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });
  assert(tb.consecutiveWinsCount === 1, 'ConsecScramble: First win sets count to 1.');
  assert(tb._scramblePending === false, 'ConsecScramble: No scramble after 1 of 2 consecutive wins.');

  await tb.onRoundEnded({ winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });
  assert(tb.consecutiveWinsCount === 2, 'ConsecScramble: Second win sets count to 2.');
  assert(tb._scramblePending === true, 'ConsecScramble: Scramble triggered after 2 consecutive wins.');
  await tb.cancelPendingScramble(null, null, true);
  tb.options.maxConsecutiveWinsWithoutThreshold = defaultTestOptions.maxConsecutiveWinsWithoutThreshold;

  // Consecutive wins disabled (threshold = 0)
  await tb.resetStreak();
  tb.options.maxConsecutiveWinsWithoutThreshold = 0;
  setGameMode('RAAS');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });
  assert(tb.consecutiveWinsCount === 1, 'ConsecDisabled: Count still increments when threshold is 0.');
  assert(tb._scramblePending === false, 'ConsecDisabled: No scramble when maxConsecutiveWinsWithoutThreshold is 0.');
  tb.options.maxConsecutiveWinsWithoutThreshold = defaultTestOptions.maxConsecutiveWinsWithoutThreshold;

  // --- Phase 3.8: Dominant Win Detection Regression Guard ---
  console.log('\n[Phase 3.8: Dominant Win Detection Regression Guard]');

  // This phase exists to catch the exact regression from commit 89b413a:
  // isDominant was initialized to false but never set to true, making the
  // dominant path unreachable. These tests verify isDominant is actually
  // evaluated and the dominant path is reachable.

  await tb.resetStreak();
  setGameMode('RAAS');
  tb.options.maxWinStreak = 2;

  // A win above the threshold should be dominant and increment the streak
  await tb.onRoundEnded({ winner: { team: 1, tickets: 350 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Regression: 350-ticket win (threshold=300) increments dominant streak.');
  assert(tb.consecutiveWinsCount === 1, 'Regression: Consecutive wins also incremented.');

  // A win below the threshold should NOT increment the dominant streak
  await tb.onRoundEnded({ winner: { team: 2, tickets: 150 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 0, 'Regression: 150-ticket win (below 300 threshold) resets dominant streak.');
  assert(tb.consecutiveWinsCount === 1, 'Regression: Consecutive wins reset to 1 for new team.');

  // Two dominant wins should trigger a scramble
  await tb.resetStreak();
  await tb.onRoundEnded({ winner: { team: 1, tickets: 400 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Regression: First dominant win.');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 400 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 2, 'Regression: Second dominant win.');
  assert(tb._scramblePending === true, 'Regression: Scramble triggered after 2 dominant wins.');
  await tb.cancelPendingScramble(null, null, true);

  // Invasion dominant detection
  await tb.resetStreak();
  setGameMode('Invasion');
  await tb.onRoundEnded({ winner: { team: 1, tickets: 350 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Regression: Invasion attacker dominant (350 >= 300).');

  await tb.resetStreak();
  await tb.onRoundEnded({ winner: { team: 2, tickets: 700 }, loser: { tickets: 0 } });
  assert(tb.winStreakCount === 1, 'Regression: Invasion defender dominant (700 >= 650).');

  // --- Final Report ---
  console.log(`\n🏁 All logic tests completed. Result: ${passCount}/${testCount} passed.`);
  if (passCount !== testCount) {
    console.error('⚠️ Some logic tests failed. Please review the output.');
    process.exitCode = 1;
  }
  if (testCount === 0) {
    console.error('⚠️ No assertions ran at all — the harness reached the end without testing anything.');
    process.exitCode = 1;
  }
}

// A rejection used to be swallowed by console.error, leaving exit 0: the file
// could crash on its first line and still report success to a runner.
try {
  await runPluginLogicTests();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  cleanAssembly(assembly);
}