/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               TB PARTY GROUPS                                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Builds the groups the scrambler must keep on one team: clan groups
 * and Squad parties, merged wherever they share a player.
 *
 * The scrambler moves squads as blocks, so a party whose members share
 * a squad already moves together. This exists for the ones that don't:
 * a party spread over two squads, or with a member in no squad at all.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * buildScrambleGroups({ clanGroups, parties, players })
 *   Returns { groups, membersOnlyTags, partyCount, splitPartyCount }.
 *   `groups` is the { tag: eosID[] } shape the scrambler's clanGroups
 *   parameter takes, with no player in two groups.
 * PARTY_TAG_PREFIX
 *   Leading marker on the tag of a group made only of parties.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * (None. Pure function over plain data.)
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - A party with members on both teams is left out. The scrambler
 *   neither reunites it nor treats either half as a unit: clan members
 *   split across teams are handled the same way.
 * - The merge is transitive. A party that overlaps a clan joins that
 *   clan's group, and two clans bridged by one party become one group.
 *   The scrambler assumes its groups are disjoint, so this has to
 *   happen before it sees them.
 * - A group that contains a clan keeps the clan tag as its name, so a
 *   round with no parties produces exactly the groups it did before.
 *
 */

export const PARTY_TAG_PREFIX = '⚑ ';

const isRealTeam = (teamID) => Number(teamID) === 1 || Number(teamID) === 2;

/**
 * @param {object} input
 * @param {Object<string, string[]>|null} input.clanGroups - From
 *   ClansService.extractClanGroups(): { tag: eosID[] }.
 * @param {Array<{members: string[]}>|null} input.parties - From
 *   players.getParties().
 * @param {Array<{eosID: string, name?: string, teamID: *}>} input.players
 * @returns {{groups: Object<string, string[]>|null, membersOnlyTags: Set<string>,
 *   partyCount: number, splitPartyCount: number}}
 *   `groups` is null when there is nothing to group. `membersOnlyTags`
 *   names the groups made only of parties: for those the scrambler takes
 *   just the members out of any extra squad, whatever the clan option for
 *   pulling whole squads says. A party is a handful of friends, and
 *   dragging a second full squad along with one of them makes a unit too
 *   big to balance with.
 */
export function buildScrambleGroups({ clanGroups = null, parties = null, players = [] } = {}) {
  const byID = new Map(players.map((p) => [p.eosID, p]));

  const entries = [];
  for (const [tag, members] of Object.entries(clanGroups || {})) {
    entries.push({ kind: 'clan', tag, members: [...members] });
  }

  let partyCount = 0;
  let splitPartyCount = 0;
  for (const party of parties || []) {
    const members = (party?.members || []).filter((eosID) => byID.has(eosID));
    if (members.length < 2) continue;
    const teams = new Set(members.map((eosID) => Number(byID.get(eosID).teamID)));
    if (teams.size !== 1 || !isRealTeam([...teams][0])) {
      splitPartyCount++;
      continue;
    }
    partyCount++;
    entries.push({ kind: 'party', tag: null, members });
  }

  if (entries.length === 0) {
    return { groups: null, membersOnlyTags: new Set(), partyCount, splitPartyCount };
  }

  // Union-find over entries: two entries sharing a player are one group.
  const parent = entries.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const ownerOf = new Map(); // eosID -> entry index that first claimed it
  entries.forEach((entry, i) => {
    for (const eosID of entry.members) {
      if (ownerOf.has(eosID)) parent[find(i)] = find(ownerOf.get(eosID));
      else ownerOf.set(eosID, i);
    }
  });

  const components = new Map(); // root -> { clanTags, members:Set }
  entries.forEach((entry, i) => {
    const root = find(i);
    if (!components.has(root)) components.set(root, { clanTags: [], members: new Set() });
    const component = components.get(root);
    if (entry.kind === 'clan') component.clanTags.push(entry.tag);
    for (const eosID of entry.members) component.members.add(eosID);
  });

  const groups = {};
  const membersOnlyTags = new Set();
  for (const component of components.values()) {
    const members = [...component.members];
    let tag;
    if (component.clanTags.length > 0) {
      tag = component.clanTags.join('+');
    } else {
      // Named after a member, never the in-game party number: that number
      // shifts whenever any other party forms or dissolves.
      const first = String(byID.get(members[0])?.name || members[0]).trim();
      tag = `${PARTY_TAG_PREFIX}${first}${members.length > 1 ? ` +${members.length - 1}` : ''}`;
      membersOnlyTags.add(tag);
    }
    // Two parties led by players with the same name would collide.
    let unique = tag;
    for (let n = 2; Object.prototype.hasOwnProperty.call(groups, unique); n++) unique = `${tag} (${n})`;
    if (membersOnlyTags.has(tag) && unique !== tag) {
      membersOnlyTags.add(unique);
    }
    groups[unique] = members;
  }

  return { groups, membersOnlyTags, partyCount, splitPartyCount };
}
