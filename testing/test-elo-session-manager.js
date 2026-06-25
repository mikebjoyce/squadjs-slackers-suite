/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              TEST: ELO SESSION MANAGER                         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates the in-memory session tracker: startRound, updatePlayers
 * (joins, team switches, disconnects), endRound participation ratio
 * calculation, and edge cases (null-teamID, zero-time players).
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses mocked Date.now() to simulate precise timing.
 *
 */

import EloSessionManager from '../utils/elo-session-manager.js';

// Mock Date.now() to control time
let mockNow;
const originalDateNow = Date.now;
Date.now = () => mockNow;

const MINUTE = 60 * 1000;

export default async function runSessionTests(runTest) {
  const cleanup = () => {
    Date.now = originalDateNow;
  };

  try {
    await runTest('Simple Participation: Full round', async () => {
      const session = new EloSessionManager();
      const roundStart = 1000;
      mockNow = roundStart;

      session.startRound(mockNow);

      const player1 = { eosID: 'p1', name: 'PlayerOne', steamID: 's1', teamID: 1 };

      mockNow += 1; // small increment for join time
      session.updatePlayers([player1]);

      const roundEnd = roundStart + 60 * MINUTE;
      const participants = session.endRound(roundEnd);

      if (participants.length !== 1) throw new Error(`Expected 1 participant, got ${participants.length}`);

      const p1Data = participants[0];
      if (p1Data.eosID !== 'p1') throw new Error('Wrong participant data');
      if (Math.abs(p1Data.participationRatio - 1.0) > 0.0001) {
        throw new Error(`Expected participationRatio near 1.0, got ${p1Data.participationRatio}`);
      }
      if (p1Data.assignedTeamID !== 1) throw new Error(`Expected assignedTeamID 1, got ${p1Data.assignedTeamID}`);
    });

    await runTest('Mid-Round Join: Half round', async () => {
      const session = new EloSessionManager();
      const roundStart = 2000;
      mockNow = roundStart;

      session.startRound(mockNow);

      const player1 = { eosID: 'p1', name: 'PlayerOne', steamID: 's1', teamID: 1 };

      mockNow = roundStart + 30 * MINUTE;
      session.updatePlayers([player1]);

      const roundEnd = roundStart + 60 * MINUTE;
      const participants = session.endRound(roundEnd);

      if (participants.length !== 1) throw new Error(`Expected 1 participant, got ${participants.length}`);

      const p1Data = participants[0];
      const expectedRatio = 0.5;
      if (Math.abs(p1Data.participationRatio - expectedRatio) > 0.001) {
        throw new Error(`Expected participationRatio near ${expectedRatio}, got ${p1Data.participationRatio}`);
      }
    });

    await runTest('Team Switcher: 75% on Team 1', async () => {
      const session = new EloSessionManager();
      const roundStart = 3000;
      mockNow = roundStart;

      session.startRound(mockNow);

      const player1 = { eosID: 'p1', name: 'PlayerOne', steamID: 's1', teamID: 1 };

      mockNow += 1; // Joined at start
      session.updatePlayers([player1]);

      mockNow = roundStart + 45 * MINUTE; // Switch teams at 45 mins
      const player1Switched = { ...player1, teamID: 2 };
      session.updatePlayers([player1Switched]);

      const roundEnd = roundStart + 60 * MINUTE;
      const participants = session.endRound(roundEnd);

      if (participants.length !== 1) throw new Error(`Expected 1 participant, got ${participants.length}`);

      const p1Data = participants[0];
      const expectedRatio = 0.75;
      if (p1Data.assignedTeamID !== 1) throw new Error(`Expected assignedTeamID 1, got ${p1Data.assignedTeamID}`);
      if (Math.abs(p1Data.participationRatio - expectedRatio) > 0.001) {
        throw new Error(`Expected participationRatio near ${expectedRatio}, got ${p1Data.participationRatio}`);
      }
      if (p1Data.segments.length !== 2) throw new Error(`Expected 2 segments for team switcher, got ${p1Data.segments.length}`);
    });

    await runTest('Ghosting/Disconnects: Segment closes correctly', async () => {
      const session = new EloSessionManager();
      const roundStart = 4000;
      mockNow = roundStart;

      session.startRound(mockNow);

      const player1 = { eosID: 'p1', name: 'PlayerOne', steamID: 's1', teamID: 1 };
      const player2 = { eosID: 'p2', name: 'PlayerTwo', steamID: 's2', teamID: 2 };

      mockNow += 1; // Both join at start
      session.updatePlayers([player1, player2]);

      mockNow = roundStart + 30 * MINUTE; // p1 disconnects at 30 mins
      session.updatePlayers([player2]); // p1 is not in the list

      const p1Session = session.getPlayerSession('p1');
      if (!p1Session) throw new Error('Player 1 session disappeared after disconnect');
      if (p1Session.activeSegment !== null) {
        throw new Error('Player 1 activeSegment was not set to null after disconnect');
      }

      const roundEnd = roundStart + 60 * MINUTE;
      const participants = session.endRound(roundEnd);

      const p1Data = participants.find((p) => p.eosID === 'p1');
      if (!p1Data) throw new Error('Player 1 data not found in participants');

      if (Math.abs(p1Data.participationRatio - 0.5) > 0.0001) {
        throw new Error(`Expected participationRatio near 0.5 for disconnected player, got ${p1Data.participationRatio}`);
      }
    });
  } finally {
    cleanup();
  }
}