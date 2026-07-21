/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      ELO SESSION MANAGER                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Pure in-memory session tracker for the EloTracker plugin. Records
 * per-player team segments across a round and computes participation
 * ratios at round end. No external dependencies.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloSessionManager (default)
 *   Class. Key public methods:
 *     startRound(timestamp)          — Clears state, sets round start.
 *     updatePlayers(currentPlayers)  — Snapshot diff; call on join and team switch.
 *     endRound(timestamp)            — Closes segments, returns participant list.
 *     getPlayerSession(eosID)        — Returns a single session or null.
 *     getSessionCount()              — Number of tracked sessions.
 *     clear()                        — Full reset of all state.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * None.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Disconnects are tracked during updatePlayers(). If a player leaves,
 *   their active segment is closed. Rejoining opens a new segment.
 * - Assigned team = the team the player spent the most time on.
 *   Defaults to team 1 on a tie or if no time was recorded.
 * - participationRatio is clamped to [0.0, 1.0]. It represents the
 *   fraction of total round duration spent on the assigned team.
 * - updatePlayers() is a snapshot diff — it DOES detect disconnects
 *   by closing segments for players not present in the current snapshot.
 *   It is called periodically to keep sessions updated.
 * - Segment objects are shared by reference between session.segments
 *   and session.activeSegment. Closing activeSegment updates the
 *   array entry in-place.
 *
 *
 * ─── AUTHOR ──────────────────────────────────────────────────────
 *
 * Slacker
 * Discord: real_slacker
 * GitHub:  https://github.com/mikebjoyce/squadjs-elo-tracker
 *
 * ═══════════════════════════════════════════════════════════════
 */

export default class EloSessionManager {
  constructor() {
    // Map<eosID, PlayerSession>
    this.sessions = new Map();
    this.roundStartTime = null;
  }

  /**
   * Starts a new round session.
   * Clears any existing session data.
   * @param {number} timestamp 
   */
  startRound(timestamp = Date.now()) {
    this.roundStartTime = timestamp;
    this.sessions.clear();
  }

  /**
   * Updates the session map based on the current player list.
   * Handles joins, team switches, and disconnects.
   * If a player is no longer in the snapshot, their segment is closed.
   * 
   * @param {Array<{eosID: string, name: string, steamID: string, teamID: number}>} currentPlayers 
   */
  updatePlayers(currentPlayers, timestamp = Date.now()) {
    if (!this.roundStartTime) return;

    const currentPlayerIDs = new Set();

    for (const player of currentPlayers) {
      const { eosID, name, steamID, teamID } = player;
      currentPlayerIDs.add(eosID);

       if (!this.sessions.has(eosID)) {
         // Condition: eosID in currentPlayers, not in session map
         // Action: Open new segment
         // NOTE (null-teamID transient): teamID may be null if RCON hasn't resolved team 
         // assignment yet (especially at NEW_GAME transition; see 
         // SQUADJS_PLUGIN_DEV_REFERENCE.md Section 3). A null segment will be created here 
         // and later closed when teamID resolves to 1 or 2. This is expected behaviour.
         const newSegment = {
           teamID: teamID,
           joinTime: timestamp,
           leaveTime: null
         };

         this.sessions.set(eosID, {
           eosID,
           name,
           steamID,
           segments: [newSegment],
           activeSegment: newSegment
         });
      } else {
        const session = this.sessions.get(eosID);

        // Update metadata if available
        if (name) session.name = name;
        if (steamID) session.steamID = steamID;

        // Check for team switch or missing active segment
        // Condition: eosID in both
        if (!session.activeSegment) {
          // activeSegment is null — reopen a segment for this player
          const newSegment = {
            teamID: teamID,
            joinTime: timestamp,
            leaveTime: null
          };
          session.segments.push(newSegment);
          session.activeSegment = newSegment;
         } else if (session.activeSegment.teamID !== teamID) {
           // Action: Team changed -> Close active segment, open new segment
           // NOTE (null-teamID transient): This branch also fires when teamID transitions 
           // from null → 1/2 (the expected null-teamID resolution case). The null segment 
           // is closed and a valid segment opened. Any time the player spent in the null state 
           // (~30–35s at NEW_GAME) contributes nothing to participationRatio and is effectively 
           // discarded. This is acceptable given the negligible impact (<1% of round duration).
           session.activeSegment.leaveTime = timestamp;

           const newSegment = {
             teamID: teamID,
             joinTime: timestamp,
             leaveTime: null
           };

           session.segments.push(newSegment);
           session.activeSegment = newSegment;  // set current
         }
        // Condition: Team unchanged -> No action
      }
    }

    // Condition: eosID in session map, not in currentPlayers
    // Action: Close active segment (player disconnected)
    for (const [eosID, session] of this.sessions.entries()) {
      if (!currentPlayerIDs.has(eosID)) {
        if (session.activeSegment && session.activeSegment.leaveTime === null) {
          session.activeSegment.leaveTime = timestamp;
          session.activeSegment = null; // Prepare for possible rejoin
        }
      }
    }
  }

  /**
   * Ends the round, closes all segments, and calculates participation.
   * @param {number} timestamp 
   * @returns {Array<Object>} ParticipantList
   */
  endRound(timestamp = Date.now()) {
    if (!this.roundStartTime) return [];

    const roundDuration = Math.max(1, timestamp - this.roundStartTime);
    const participants = [];

    for (const session of this.sessions.values()) {
      // Close active segment if it's still open
      if (session.activeSegment && session.activeSegment.leaveTime === null) {
        session.activeSegment.leaveTime = timestamp;
      }

      // Compute participation
      let timeOnTeam1 = 0;
      let timeOnTeam2 = 0;

      for (const segment of session.segments) {
        // Safety: if leaveTime is null (shouldn't be after above), use timestamp
        const endTime = segment.leaveTime !== null ? segment.leaveTime : timestamp;
        const duration = Math.max(0, endTime - segment.joinTime);

        if (segment.teamID === 1) {
          timeOnTeam1 += duration;
        } else if (segment.teamID === 2) {
          timeOnTeam2 += duration;
        }
      }

       // Edge case guard: If player recorded absolutely 0 time on either team,
       // they are in a bugged state (e.g. fully unassigned the entire match).
       // This commonly happens for players who were in a null-teamID segment that resolved,
       // and then disconnected before opening a valid segment (i.e. left during the map load screen).
       if (timeOnTeam1 === 0 && timeOnTeam2 === 0) {
         // We log it and skip pushing them to the participants array.
         // In the rare event someone triggers this, they shouldn't receive a rating update anyway.
         // NOTE: Since the caller will use a minParticipationRatio filter, this is just a clean-up guard.
         continue;
       }

      // Determine assigned team (most time played)
      // Default to team 1 if equal
      const assignedTeamID = timeOnTeam2 > timeOnTeam1 ? 2 : 1;
      const timeOnAssigned = assignedTeamID === 1 ? timeOnTeam1 : timeOnTeam2;

      // Calculate ratio clamped [0.0, 1.0]
      let participationRatio = timeOnAssigned / roundDuration;
      participationRatio = Math.min(Math.max(participationRatio, 0.0), 1.0);

      participants.push({
        eosID: session.eosID,
        name: session.name,
        steamID: session.steamID,
        assignedTeamID,
        participationRatio,
        timeOnTeam1,
        timeOnTeam2,
        segments: [...session.segments]
      });
    }

    return participants;
  }

  getPlayerSession(eosID) {
    return this.sessions.get(eosID) || null;
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  getSessionCount() {
    return this.sessions.size;
  }

  clear() {
    this.sessions.clear();
    this.roundStartTime = null;
  }
}