/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   FAKE PARTY RCON — AdminForceTeamChange with Squad parties   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * A small in-memory server whose AdminForceTeamChange behaves the way
 * Squad's does since the October 2026 party patch, as observed on a live
 * server:
 *
 *   - the command toggles the named player's team;
 *   - if that player is their party's leader, every other member is set
 *     to the leader's new team in the same step (a mate already there
 *     stays put — the drag sets the team, it doesn't toggle it);
 *   - a member who isn't the leader moves alone.
 *
 * One observed oddity is modelled too: a party marked `dragsBothWays`
 * drags everyone whichever member is moved (two fresh joiners did this
 * once, before the game had settled their party).
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * createPartyWorld(players)
 *   players: [{ eosID, steamID?, name, teamID, party?, leader?, dragsBothWays? }]
 *   Returns {
 *     roster,     — the live player objects (mutated by commands)
 *     commands,   — every identifier AdminForceTeamChange was sent
 *     rcon,       — { execute(cmd) } for server.rcon
 *     players,    — an S³ players-service stand-in (getPlayer, getAllPlayers,
 *                   refreshNow, recordMove, canAct, rememberReconnect)
 *     teamOf(eosID),
 *     refuse      — set true to make the game accept commands but move
 *                   nobody (the faction vote does this)
 *   }
 */

'use strict';

export function createPartyWorld(players) {
  const roster = players.map((p) => ({ steamID: null, party: null, leader: false, dragsBothWays: false, ...p }));
  const commands = [];

  const world = {
    roster,
    commands,
    refuse: false,
    teamOf: (eosID) => roster.find((p) => p.eosID === eosID)?.teamID ?? null,
    rcon: {
      async execute(cmd) {
        const match = cmd.match(/^AdminForceTeamChange "(.*)"$/);
        const identifier = match ? match[1] : null;
        commands.push(identifier);
        const hit = roster.find((p) => p.eosID === identifier || p.steamID === identifier);
        if (!hit) return `ERROR: Unable to find player with name or id (${identifier})`;
        if (world.refuse) return `Forced team change for player. [Online IDs= EOS: ${hit.eosID}] ${hit.name}`;

        hit.teamID = hit.teamID === 1 ? 2 : 1;
        if (hit.party && (hit.leader || hit.dragsBothWays)) {
          for (const mate of roster) {
            if (mate !== hit && mate.party === hit.party) mate.teamID = hit.teamID;
          }
        }
        return `Forced team change for player. [Online IDs= EOS: ${hit.eosID}] ${hit.name}`;
      }
    },
    players: {
      getPlayer: (id) => {
        const p = roster.find((r) => r.eosID === id || r.steamID === id);
        return p ? { ...p } : null;
      },
      getAllPlayers: () => roster.map((p) => ({ ...p })),
      refreshNow: async () => {},
      recordMove: () => {},
      canAct: () => true,
      rememberReconnect: async () => {}
    }
  };
  return world;
}
