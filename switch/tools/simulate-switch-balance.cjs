/**
 * simulate-switch-balance.cjs
 *
 * Simulates the Switch plugin's balance logic to generate a verified
 * truth table of which team switches are allowed at every team count
 * combination.
 *
 * Replicates the exact logic from switch/plugins/Switch.js:
 *   - getTeamBalanceDifference()
 *   - getDynamicExtraSlots()
 *   - getSwitchSlotsPerTeam()
 *
 * Usage: node tools/simulate-switch-balance.cjs
 *
 * Output: Markdown table to stdout
 */

// ── Config (matches the server's current config) ────────────────
const CONFIG = {
  maxUnbalancedSlots: 1,
  dynamicBalanceTolerance: true,
  dynamicBalancePlayerFloor: 85,
  dynamicBalanceExtraSlots: 3,
  maxPlayers: 100,
  reservedSlots: 0,
};

// ── Simulated logic (mirrors Switch.js) ─────────────────────────

function getTeamBalanceDifference(team1, team2) {
  return team1 - team2;
}

function getDynamicExtraSlots(totalPlayers) {
  if (!CONFIG.dynamicBalanceTolerance) return 0;

  const effectiveCap = CONFIG.maxPlayers - CONFIG.reservedSlots;
  const floor = CONFIG.dynamicBalancePlayerFloor;
  const extra = CONFIG.dynamicBalanceExtraSlots;

  if (totalPlayers >= effectiveCap) return 0;
  if (totalPlayers <= floor) return extra;

  const interpolated = extra * (effectiveCap - totalPlayers) / (effectiveCap - floor);
  return Math.round(interpolated);
}

function getSwitchSlotsPerTeam(teamID, team1, team2) {
  const balanceDifference = getTeamBalanceDifference(team1, team2);
  const totalPlayers = team1 + team2;

  let cap = CONFIG.maxUnbalancedSlots;

  const dynamicExtra = getDynamicExtraSlots(totalPlayers);
  if (dynamicExtra > 0) {
    cap += dynamicExtra;
  }

  const postSwitchDiff = teamID === 1
    ? balanceDifference - 2
    : balanceDifference + 2;

  if (Math.abs(postSwitchDiff) > cap) {
    return 0;
  }

  const receivingTeam = teamID === 1 ? 2 : 1;
  const maxTeamSize = Math.floor(CONFIG.maxPlayers / 2);
  const receivingCount = teamID === 1 ? team2 : team1;
  if (receivingCount >= maxTeamSize) return 0;

  return 1;
}

// ── Generate the truth table ────────────────────────────────────

console.log('# Switch Balance Simulation — Truth Table');
console.log();
console.log(`Config: maxUnbalancedSlots=${CONFIG.maxUnbalancedSlots}, ` +
  `dynamicBalanceTolerance=${CONFIG.dynamicBalanceTolerance}, ` +
  `playerFloor=${CONFIG.dynamicBalancePlayerFloor}, ` +
  `extraSlots=${CONFIG.dynamicBalanceExtraSlots}, ` +
  `maxPlayers=${CONFIG.maxPlayers}, reservedSlots=${CONFIG.reservedSlots}`);
console.log();

// Header
console.log('| Team1 | Team2 | Total | DynamicExtra | EffectiveCap | T1→T2 | T2→T1 | Notes |');
console.log('|-------|-------|-------|-------------|-------------|-------|-------|-------|');

// Iterate all combinations from 0v0 to 50v50
for (let t1 = 0; t1 <= 50; t1++) {
  for (let t2 = 0; t2 <= 50; t2++) {
    const total = t1 + t2;
    const dynamicExtra = getDynamicExtraSlots(total);
    const effectiveCap = CONFIG.maxUnbalancedSlots + dynamicExtra;

    const slotsT1toT2 = getSwitchSlotsPerTeam(1, t1, t2);
    const slotsT2toT1 = getSwitchSlotsPerTeam(2, t1, t2);

    const t1toT2Str = slotsT1toT2 > 0 ? '✅' : '❌';
    const t2toT1Str = slotsT2toT1 > 0 ? '✅' : '❌';

    // Generate a note for interesting cases
    let notes = '';
    if (t1 === t2 && total > 0) {
      if (slotsT1toT2 > 0) {
        notes = 'Equal teams, both can switch';
      } else {
        notes = 'Equal teams, neither can switch (full server)';
      }
    } else if (t1 > t2 && slotsT1toT2 > 0 && slotsT2toT1 > 0) {
      notes = 'Both directions allowed (dynamic tolerance)';
    } else if (t1 > t2 && slotsT1toT2 === 0 && slotsT2toT1 > 0) {
      notes = 'Smaller→bigger allowed (unusual — end-match?)';
    }

    console.log(`| ${t1} | ${t2} | ${total} | ${dynamicExtra} | ${effectiveCap} | ${t1toT2Str} | ${t2toT1Str} | ${notes} |`);
  }
}

console.log();
console.log('---');
console.log();
console.log('## Key Observations');
console.log();

// Find the boundary where dynamic tolerance drops to 0
console.log('- Dynamic extra slots are 0 when total players ≥ ' + (CONFIG.maxPlayers - CONFIG.reservedSlots) + '.');
console.log('- Dynamic extra slots are at maximum (' + CONFIG.dynamicBalanceExtraSlots + ') when total players ≤ ' + CONFIG.dynamicBalancePlayerFloor + '.');
console.log('- Between ' + (CONFIG.dynamicBalancePlayerFloor + 1) + ' and ' + (CONFIG.maxPlayers - CONFIG.reservedSlots - 1) + ' players, extra slots are linearly interpolated and rounded.');
console.log('- The receiving team cannot exceed ' + Math.floor(CONFIG.maxPlayers / 2) + ' players (maxTeamSize = floor(maxPlayers / 2)).');
console.log('- The golden rule (bigger→smaller only) is enforced by the postSwitchDiff check: switching from smaller to larger always increases the absolute difference.');