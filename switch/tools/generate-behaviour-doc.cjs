#!/usr/bin/env node
/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  SWITCH PLUGIN — BEHAVIOUR DOCUMENTATION GENERATOR            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Standalone script that produces an informative reference document
 * describing how the Switch plugin works. The generated text mirrors
 * the content of the in-game '!switch explain' command and the
 * Discord explain channel embed sequence.
 *
 * Config values are read from a JSON file (defaults to the companion
 * behaviour-config.json in the same directory). Edit the JSON to
 * experiment with different settings and see how the behaviour
 * description changes.
 *
 * ─── CUSTOMISATION ───────────────────────────────────────────────
 *
 * To change the generated output, edit behaviour-config.json (or
 * create a copy and pass --config <path>). Every switch setting is
 * exposed — tweak cooldowns, token counts, balance tolerance, etc.
 * and re-run to see how the player-facing rules description changes.
 *
 * For a community-friendly doc (no config paths, no appendix tables,
 * no "auto-generated" disclaimer), set "_publicFacing": true in the
 * config JSON. This strips admin/dev metadata from the output.
 *
 * Example — generate a clean doc for your community:
 *   cp switch/tools/behaviour-config.json my-server-config.json
 *   # edit my-server-config.json to match your server's settings
 *   # set "_publicFacing": true
 *   node switch/tools/generate-behaviour-doc.cjs --config my-server-config.json --output docs/switch-rules.md
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   # Use defaults (companion behaviour-config.json, switch/SWITCH_BEHAVIOUR.md)
 *   node switch/tools/generate-behaviour-doc.cjs
 *
 *   # Custom config file
 *   node switch/tools/generate-behaviour-doc.cjs --config my-config.json
 *
 *   # Custom output path
 *   node switch/tools/generate-behaviour-doc.cjs --output docs/custom-behaviour.md
 *
 *   # Custom config + output
 *   node switch/tools/generate-behaviour-doc.cjs --config my-config.json --output out.md
 *
 *   # Help
 *   node switch/tools/generate-behaviour-doc.cjs --help
 *
 * ─── AUTHOR ──────────────────────────────────────────────────────
 *
 * Discord: `real_slacker`
 * GitHub:  https://github.com/mikebjoyce
 *
 * ═════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');

// ── CLI Parsing ─────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node switch/tools/generate-behaviour-doc.cjs [options]

Options:
  --config <path>   Path to config JSON file
                    (default: switch/tools/behaviour-config.json)
  --output <path>   Output markdown file path
                    (default: switch/SWITCH_BEHAVIOUR.md)
  --help, -h        Show this help message

Examples:
  node switch/tools/generate-behaviour-doc.cjs
  node switch/tools/generate-behaviour-doc.cjs --config my-config.json
  node switch/tools/generate-behaviour-doc.cjs --output docs/custom-behaviour.md
`);
  process.exit(0);
}

function parseArg(name) {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

const configArg = parseArg('--config');
const outputArg = parseArg('--output');

// ── Config Loading ──────────────────────────────────────────────

const scriptDir = __dirname;
const configPath = configArg
  ? path.resolve(scriptDir, configArg)
  : path.join(scriptDir, 'behaviour-config.json');

let rawConfig;
try {
  rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (err) {
  console.error(`❌ Failed to load config from "${configPath}":`, err.message);
  process.exit(1);
}

// ── Resolve config ──────────────────────────────────────────────

const SERVER_CONFIG = {
  AllowTeamChanges: rawConfig.serverConfig?.AllowTeamChanges ?? false,
  MaxPlayers: rawConfig.serverConfig?.MaxPlayers ?? 100,
  NumReservedSlots: rawConfig.serverConfig?.NumReservedSlots ?? 2,
};

// ⚠️ Aligned with switch-explain.js _getMaxTeamSize(): effectiveCap = maxPlayers (does NOT subtract reserved slots).
// Reserved slots are still tracked for the info display, but they do not shrink the team-size cap.
const EFFECTIVE_MAX_PLAYERS = SERVER_CONFIG.MaxPlayers;
const MAX_TEAM_SIZE = Math.floor(EFFECTIVE_MAX_PLAYERS / 2);

const CFG = {
  commandPrefix:                     rawConfig.commandPrefix ?? ['!switch', '!change'],
  doubleSwitchCommands:              rawConfig.doubleSwitchCommands ?? ['!bug', '!stuck', '!doubleswitch'],
  doubleSwitchCooldownHours:         rawConfig.doubleSwitchCooldownHours ?? 0.5,
  doubleSwitchDelaySeconds:          rawConfig.doubleSwitchDelaySeconds ?? 1,
  endMatchSwitchSlots:               rawConfig.endMatchSwitchSlots ?? 3,
  switchCooldownHours:               rawConfig.switchCooldownHours ?? 1.75,
  switchCooldownMinutes:             rawConfig.switchCooldownMinutes ?? 0,
  switchEnabledMinutes:              rawConfig.switchEnabledMinutes ?? 10,
  // ⚠️ Aligned with switch-explain.js: fallback default is 20 minutes (not 15).
  // The explain system uses `plugin.options.queueTimeoutMinutes ?? 20` to handle
  // the unconfigured case. The companion config file explicitly sets 15, so the
  // live explain output will show 15 when the option is present in plugin config.
  queueTimeoutMinutes:               rawConfig.queueTimeoutMinutes ?? 20,
  doubleSwitchEnabledMinutes:        rawConfig.doubleSwitchEnabledMinutes ?? 10,
  maxUnbalancedSlots:                rawConfig.maxUnbalancedSlots ?? 1,
  scrambleLockdownDurationMinutes:   rawConfig.scrambleLockdownDurationMinutes ?? 30,
  scrambleLockdownMinPlayers:        rawConfig.scrambleLockdownMinPlayers ?? 60,
  liberalSwitchGameModes:            rawConfig.liberalSwitchGameModes ?? ['Seed', 'Jensen'],
  liberalSwitchMaxUnbalancedSlots:   rawConfig.liberalSwitchMaxUnbalancedSlots ?? 6,
  liberalSwitchBroadcastIntervalMinutes: rawConfig.liberalSwitchBroadcastIntervalMinutes ?? 8,
  dynamicBalanceTolerance:           rawConfig.dynamicBalanceTolerance ?? true,
  dynamicBalancePlayerFloor:         rawConfig.dynamicBalancePlayerFloor ?? 85,
  dynamicBalanceExtraSlots:          rawConfig.dynamicBalanceExtraSlots ?? 3,
  maxSwitchTokens:                   rawConfig.maxSwitchTokens ?? 2,
  seedTokenBonusAmount:              rawConfig.seedTokenBonusAmount ?? 1,
  seedTokenBonusMinutes:             rawConfig.seedTokenBonusMinutes ?? 20,
  seedTokenBonusMinPlayers:          rawConfig.seedTokenBonusMinPlayers ?? 0,
  // ⚠️ Aligned with switch-explain.js: the explain system evaluates
  // `plugin.options.queueTimeoutSwitchEnabled === true` which returns false
  // when the option is undefined. The `??` default must be `false` (not `true`)
  // to match that behavior. When the option IS explicitly configured as true
  // in the plugin config, `CFG.queueTimeoutSwitchEnabled` will be true from
  // the rawConfig.
  queueTimeoutSwitchEnabled:         rawConfig.queueTimeoutSwitchEnabled ?? false,
  // ⚠️ Aligned with switch-explain.js: queueEnabled defaults to true via
  // `plugin.options.queueEnabled !== false` (undefined !== false → true).
  // Using `?? true` produces the same result but more explicitly.
  queueEnabled:                      rawConfig.queueEnabled ?? true,
};

// ── Helpers ────────────────────────────────────────────────────

function fmtMinutes(min) {
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h} hour${h !== 1 ? 's' : ''}`;
  return `${h} hour${h !== 1 ? 's' : ''} ${m} minute${m !== 1 ? 's' : ''}`;
}

function fmtCooldown() {
  if (CFG.switchCooldownMinutes > 0) {
    return fmtMinutes(CFG.switchCooldownMinutes);
  }
  const hrs = CFG.switchCooldownHours;
  if (hrs === 0) return 'none';
  return `${hrs} hour${hrs !== 1 ? 's' : ''}`;
}

function fmtCooldownHours() {
  const hrs = CFG.switchCooldownMinutes > 0
    ? (CFG.switchCooldownMinutes / 60).toFixed(1)
    : CFG.switchCooldownHours;
  return `${hrs}h`;
}

// ── Tolerance Table Builder ────────────────────────────────────

function buildToleranceTable() {
  const cap = CFG.maxUnbalancedSlots;
  const floor = CFG.dynamicBalancePlayerFloor;
  const extraSlots = CFG.dynamicBalanceExtraSlots;
  const effectiveCap = EFFECTIVE_MAX_PLAYERS;

  if (!CFG.dynamicBalanceTolerance) {
    return [{ range: 'All population levels', extra: 0, maxGap: cap }];
  }

  const rows = [];
  let prevExtra = null;
  let rangeStart = 1;

  for (let totalPlayers = 1; totalPlayers <= effectiveCap; totalPlayers++) {
    let currentExtra;
    if (totalPlayers >= effectiveCap) {
      currentExtra = 0;
    } else if (totalPlayers <= floor) {
      currentExtra = extraSlots;
    } else {
      const raw = Math.round(extraSlots * (effectiveCap - totalPlayers) / (effectiveCap - floor));
      currentExtra = raw === 0 && totalPlayers < effectiveCap ? 1 : raw;
    }

    if (currentExtra !== prevExtra) {
      if (prevExtra !== null) {
        const rangeEnd = totalPlayers - 1;
        rows.push({
          range: rangeStart === rangeEnd ? String(rangeStart) : `${rangeStart}-${rangeEnd}`,
          extra: prevExtra,
          maxGap: cap + prevExtra,
        });
      }
      rangeStart = totalPlayers;
      prevExtra = currentExtra;
    }
  }

  if (prevExtra !== null && rangeStart <= effectiveCap - 1) {
    rows.push({
      range: rangeStart === effectiveCap - 1 ? String(effectiveCap - 1) : `${rangeStart}-${effectiveCap - 1}`,
      extra: prevExtra,
      maxGap: cap + prevExtra,
    });
  }

  rows.push({ range: `${effectiveCap}+`, extra: 0, maxGap: cap });
  return rows;
}

// ── Generate Markdown ──────────────────────────────────────────

function generate() {
  const toleranceRows = buildToleranceTable();
  const cooldownStr = fmtCooldown();
  const maxTokens = CFG.maxSwitchTokens;
  const showTokenMessaging = maxTokens > 1;
  const liberalModes = CFG.liberalSwitchGameModes.join(' & ');
  const seedBonusEnabled = CFG.seedTokenBonusAmount > 0 && CFG.seedTokenBonusMinutes > 0;
  const publicFacing = rawConfig._publicFacing === true;

  // ⚠️ Always read queue configuration from CFG (which has proper defaults).
  // Using CFG instead of rawConfig ensures defaults are consistent between
  // the generator and the explain system, even if the config file omits a key.
  const queueEnabled = CFG.queueEnabled;
  const timeoutSwitchEnabled = CFG.queueTimeoutSwitchEnabled;

  const lines = [];

  lines.push(`# Switch Plugin — Behaviour Reference`);
  lines.push(``);

  if (!publicFacing) {
    lines.push(`> **Reference document.** Describes how team switching works on this server based on the configuration in \`${path.relative(process.cwd(), configPath)}\`. If your server administrator has changed any settings, the live behaviour may differ.`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);

  // ═══════════════════════════════════════════════════════════════
  // SECTION 1: INTRODUCTION
  // ═══════════════════════════════════════════════════════════════
  const scoreboardDisabled = !SERVER_CONFIG.AllowTeamChanges;

  lines.push(`## How Team Switching Works`);
  lines.push(``);
  if (scoreboardDisabled) {
    lines.push(`Squad's native team change command is disabled on this server. **\`!switch\`** is how you change teams. The plugin enforces balance rules to keep teams fair while still allowing you to play with your friends.`);
  } else {
    lines.push(`**\`!switch\`** is an alternative way to change teams. The plugin enforces balance rules to keep teams fair while still allowing you to play with your friends.`);
  }
  lines.push(``);
  lines.push(`### Commands`);
  lines.push(``);
  lines.push(`| Command | Description |`);
  lines.push(`|---------|-------------|`);
  lines.push(`| \`!switch\` | Request a team change |`);
  lines.push(`| \`!switch check\` | See your eligibility and token balance |`);
  lines.push(`| \`!switch cancel\` | Leave the switch queue |`);
  lines.push(``);
  lines.push(`*All three commands are typed in all, team or squad chat.*`);
  lines.push(``);
  lines.push(`### Key Rule`);
  lines.push(``);
  lines.push(`- Switching from the **bigger team** to the **smaller team** is usually allowed.`);
  lines.push(`- Switching from the **smaller team** to the **bigger team** is only allowed if the gap stays within the balance limit (see below).`);
  lines.push(``);

  lines.push(`---`);
  lines.push(``);

  // ═══════════════════════════════════════════════════════════════
  // SECTION 2: BALANCE RULES
  // ═══════════════════════════════════════════════════════════════
  lines.push(`## Balance Rules`);
  lines.push(``);
  lines.push(`A switch is allowed if it does not make the teams too lopsided. The rules depend on how many players are on the server.`);
  lines.push(``);
  lines.push(`### What the numbers mean`);
  lines.push(``);
  lines.push(`The **gap** is the difference in player count between the two teams.`);
  lines.push(``);
  lines.push(`Example: Team **1** has **42** players, Team **2** has **38**. The gap is **4**.`);
  lines.push(``);
  lines.push(`**Tolerance** is how much extra gap the server allows beyond the base limit of **${CFG.maxUnbalancedSlots}**. At low population, more tolerance is given so switches are easier. As the server fills up, tolerance shrinks to keep teams fair when it matters most.`);
  lines.push(``);
  lines.push(`### Tolerance Table`);
  lines.push(``);
  lines.push(`| Players | Extra Tolerance | Max Allowed Gap |`);
  lines.push(`|---------|----------------|-----------------|`);
  for (const row of toleranceRows) {
    lines.push(`| ${row.range} | ${row.extra} | ${row.maxGap} |`);
  }
  lines.push(``);

  // Pick a representative row for example
  const exampleRowIdx = Math.floor((toleranceRows.length - 1) / 2);
  const exampleRow = toleranceRows[exampleRowIdx];
  const gap = exampleRow.maxGap;

  lines.push(`### Example`);
  lines.push(``);
  lines.push(`With **${exampleRow.range}** population, the max allowed gap is **${gap}**.`);
  lines.push(`- If the bigger team leads by **${gap}**, a switch from the bigger team is allowed (gap shrinks to **${Math.max(0, gap - 2)}**).`);
  lines.push(`- A switch from the smaller team is **not** allowed (gap would grow to **${gap + 2}**, exceeding the max of **${gap}**).`);
  lines.push(``);
  lines.push(`### Hard Cap`);
  lines.push(``);
  lines.push(`Each team can hold at most **${MAX_TEAM_SIZE}** players (half of **${EFFECTIVE_MAX_PLAYERS}** total slots, including **${SERVER_CONFIG.NumReservedSlots}** reserved).`);
  lines.push(`You cannot switch to a team that is already at **${MAX_TEAM_SIZE}**.`);
  lines.push(``);

  lines.push(`---`);
  lines.push(``);

  // ═══════════════════════════════════════════════════════════════
  // SECTION 3: COOLDOWN / TOKEN SYSTEM
  // ═══════════════════════════════════════════════════════════════
  if (showTokenMessaging) {
    lines.push(`## Switch Tokens`);
    lines.push(``);
    lines.push(`Each **\`!switch\`** costs **1** token. Tokens refill automatically over time. You are not locked out for a full cooldown after a single switch.`);
    lines.push(``);
    lines.push(`### Token Pool`);
    lines.push(``);
    lines.push(`- Maximum tokens: **${maxTokens}**`);
    lines.push(`- Refill time: **${cooldownStr}** per token`);
    lines.push(``);
    lines.push(`### How It Works`);
    lines.push(``);
    lines.push(`Tokens refill one at a time, independently. With **${maxTokens}** tokens saved, you can switch up to ${maxTokens} times before waiting for a refill. This gives you flexibility without allowing unlimited switching.`);
    lines.push(``);

    if (seedBonusEnabled) {
      const minNote = CFG.seedTokenBonusMinPlayers > 0
        ? ` (only while **${CFG.seedTokenBonusMinPlayers}+** players are online)`
        : '';
      lines.push(`### Seed Bonus`);
      lines.push(``);
      lines.push(`During seed rounds, you earn **+1** bonus token for every **${CFG.seedTokenBonusMinutes}** minutes you are present${minNote}.`);
      lines.push(`You can earn up to **${CFG.seedTokenBonusAmount}** bonus token${CFG.seedTokenBonusAmount !== 1 ? 's' : ''} per seed round.`);
      lines.push(`Bonus tokens stack above your normal cap of **${maxTokens}**, so after a full seed round you could hold up to **${maxTokens + CFG.seedTokenBonusAmount}** tokens total.`);
      lines.push(``);
    }
  } else {
    lines.push(`## Switch Cooldown`);
    lines.push(``);
    lines.push(`After using **\`!switch\`**, you must wait before switching again.`);
    lines.push(``);
    lines.push(`Cooldown: **${cooldownStr}**`);
    lines.push(``);
    lines.push(`You cannot switch again until the cooldown expires. Use **\`!switch check\`** to see your remaining cooldown time.`);
    lines.push(``);
  }

  if (showTokenMessaging) {
    lines.push(`### Checking Your Balance`);
    lines.push(``);
    lines.push(`Use **\`!switch check\`** to see your current token balance and when your next token refills.`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);

  // ═══════════════════════════════════════════════════════════════
  // SECTION 4: TIME WINDOW & QUEUE
  // ═══════════════════════════════════════════════════════════════
  lines.push(`## Time Window & Queue`);
  lines.push(``);
  lines.push(`You can only use **\`!switch\`** during a limited window.${queueEnabled ? ' If teams are currently full, you will be placed in a queue.' : ''}`);
  lines.push(``);
  lines.push(`### Time Window`);
  lines.push(``);
  lines.push(`- You have **${CFG.switchEnabledMinutes} minutes** after joining the server`);
  lines.push(`- **OR** after the match starts, whichever gives you more time.`);
  lines.push(`- If you join mid-match, your personal time window starts when you joined.`);
  lines.push(`- Once both windows close, **\`!switch\`** is unavailable for the rest of the match.`);
  lines.push(``);

  if (queueEnabled) {
    lines.push(`### The Queue`);
    lines.push(``);
    lines.push(`- If no switch slot is immediately available, you are placed in a queue.`);
    lines.push(`- The queue holds your spot and processes switches as soon as a slot opens.`);
    lines.push(`- For example, when someone on the other team also types **\`!switch\`**, that creates room for you to move.`);
    lines.push(`- The queue checks for available slots every few seconds as the server updates its player counts. It will not act on incomplete or stale data.`);
    lines.push(`- Note: the in-game scoreboard can be slow to update. The queue uses its own player count tracking and is more reliable than the scoreboard.`);
    lines.push(`- You have **${CFG.queueTimeoutMinutes} minutes** in the queue before your request expires.`);
    lines.push(``);
    if (timeoutSwitchEnabled) {
      lines.push(`If your queue request reaches the **${CFG.queueTimeoutMinutes}-minute** time limit without a normal slot opening, the system will force-switch you with a slightly relaxed balance limit. This is a fallback so you are not left stranded. The normal balance rules are your best path.`);
    } else {
      lines.push(`When a queued switch expires, you are removed from the queue.`);
    }
    lines.push(``);
    lines.push(`Use **\`!switch cancel\`** to leave the queue at any time.`);
    lines.push(``);
  } else {
    lines.push(`### Queue Status`);
    lines.push(``);
    lines.push(`The queue is currently disabled.`);
    lines.push(`If no slot is available when you request a switch, you will need to try again later.`);
    lines.push(`Use **\`!switch check\`** to see if a slot is available.`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);

  // ═══════════════════════════════════════════════════════════════
  // SECTION 5: SCRAMBLES
  // ═══════════════════════════════════════════════════════════════
  lines.push(`## Scrambles & Switching`);
  lines.push(``);
  lines.push(`A scramble is when the server shuffles players to rebalance teams after one-sided rounds. After a scramble, switching is temporarily locked.`);
  lines.push(``);
  lines.push(`### What a Scramble Does`);
  lines.push(``);
  lines.push(`- The scrambler keeps squads and clans together. Your squad and clan group will not be split up.`);
  lines.push(``);
  lines.push(`- When a clan group is kept together, the rest of their squad is pulled along with them. No one gets left behind.`);
  lines.push(``);
  lines.push(`### Post-Scramble Lockout`);
  lines.push(``);
  lines.push(`- After a scramble, **\`!switch\`** is locked for all players for **${CFG.scrambleLockdownDurationMinutes} minutes**.`);
  lines.push(`- This prevents players from undoing the scramble by switching back.`);
  lines.push(`- The system is designed to help you play with your friends, even when things go wrong. If a scramble fails to move you, or you reconnect to the wrong team, your restrictions are cleared so you can fix it yourself.`);
  lines.push(``);
  lines.push(`### Lockout Exceptions`);
  lines.push(``);
  lines.push(`You are **NOT** locked after a scramble if:`);
  lines.push(`- You are still within your **${CFG.switchEnabledMinutes}-minute** join/match window.`);
  lines.push(`- You were already in the switch queue before the scramble fired.`);
  lines.push(`- The scramble **failed to move you** (RCON error). Your scramble lock is cleared and you may receive a **+1 switch token** so you can use \`!switch\` immediately to rejoin your group.`);
  lines.push(`- The scramble failed to keep your squad or clan together. In this case, you are given extra leniency to switch back to your group when your join/match window opens.`);
  lines.push(``);
  lines.push(`### Reconnecting After a Scramble`);
  lines.push(``);
  lines.push(`- If you disconnect and reconnect to a different team after a scramble, your switch restrictions (including the scramble lockout) are cleared.`);
  lines.push(`- You can use **\`!switch\`** immediately to return to your previous team.`);
  lines.push(`- If you reconnect during a faction vote, an ignored game mode, or passive mode, your scramble lock is still cleared so you are not stranded. Use \`!switch\` when the round starts.`);
  lines.push(``);

  lines.push(`---`);
  lines.push(``);

  // ═══════════════════════════════════════════════════════════════
  // SECTION 6: SPECIAL CASES
  // ═══════════════════════════════════════════════════════════════
  lines.push(`## Special Cases`);
  lines.push(``);
  lines.push(`Some game modes and situations change how the normal rules apply.`);
  lines.push(``);
  lines.push(`### ${CFG.liberalSwitchGameModes.join(' & ')} Rounds`);
  lines.push(``);
  lines.push(`During **${liberalModes}** rounds, switching is relaxed:`);
  lines.push(`- **No time window limit.** Switch at any point during the round.`);
  lines.push(`- **No token cost.** Switches do not consume tokens.`);
  lines.push(`- **More permissive balance limit.** Up to **${CFG.liberalSwitchMaxUnbalancedSlots}** players difference is allowed instead of the normal tolerance.`);
  lines.push(``);
  lines.push(`### Faction Vote (Between Rounds)`);
  lines.push(``);
  lines.push(`- During the faction vote screen between rounds, **\`!switch\`** is unavailable.`);
  lines.push(`- The queue is paused. When the next round begins, the queue is cleared.`);
  lines.push(`- You will need to re-queue if you still want to switch.`);
  lines.push(``);

  lines.push(`---`);
  lines.push(``);

  // ═══════════════════════════════════════════════════════════════
  // SECTION 7: TIPS
  // ═══════════════════════════════════════════════════════════════
  lines.push(`## Tips for Playing With Friends`);
  lines.push(``);
  lines.push(`The system is designed to help you end up on the same team as your friends. Here is how to make the most of it.`);
  lines.push(``);

  const tips = [
    `**1. Switch early.** Your **${CFG.switchEnabledMinutes}-minute** window starts when you join. Do not wait until the last minute.`,
  ];

  if (maxTokens > 1) {
    tips.push(`**2. Save a token.** With **${maxTokens}** tokens, you can switch more than once before waiting for a refill. This gives you flexibility if you need to switch multiple times in a session.`);
  } else {
    tips.push(`**2. Plan your switch.** After switching, you must wait through the full cooldown before switching again. Make every switch count.`);
  }

  tips.push(`**3. Use seed rounds.** Seed and Jensen rounds have no token cost and no time limit. Use this time to position yourself on the right team for free.`);
  tips.push(`**4. Check before you act.** **\`!switch check\`** tells you exactly what is blocking you: time window, tokens, scramble lock, or balance. This helps you make an informed decision.`);
  tips.push(`**5. Squads and clans stay together.** The scrambler preserves squads and clan groups. Even if a scramble fires, your group will not be split up.`);
  tips.push(`**6. The system has your back.** Even when things go wrong (a scramble fails to move you, or you reconnect to the wrong team), your restrictions are cleared and you may receive bonus tokens so you can fix it yourself. You are never permanently stranded.`);

  for (const tip of tips) {
    lines.push(tip);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);

  // ═══════════════════════════════════════════════════════════════
  // APPENDIX: CONFIGURATION VALUES (omitted in public-facing mode)
  // ═══════════════════════════════════════════════════════════════
  if (!publicFacing) {
    lines.push(`## Configuration Values`);
    lines.push(``);
    lines.push(`The following table lists every configuration option with the value used to generate this document. These come from the JSON config file — edit that file and re-run the generator to preview how changes affect the player-facing rules. If your server admin has changed any settings, the live behaviour will differ.`);
    lines.push(``);
    lines.push(`### Core Switch Behaviour`);
    lines.push(``);
    lines.push(`| Option | Value | Description |`);
    lines.push(`|--------|-------|-------------|`);
    lines.push(`| \`commandPrefix\` | \`${JSON.stringify(CFG.commandPrefix)}\` | Command prefix(es) to trigger switch |`);
    lines.push(`| \`switchCooldownHours\` | ${CFG.switchCooldownHours} | Hours per-token refill interval |`);
    lines.push(`| \`switchCooldownMinutes\` | ${CFG.switchCooldownMinutes} | Minutes per-token refill interval (overrides hours if > 0) |`);
    lines.push(`| \`switchEnabledMinutes\` | ${CFG.switchEnabledMinutes} | Time window (minutes) after join/match start to request a switch |`);
    lines.push(`| \`queueTimeoutMinutes\` | ${CFG.queueTimeoutMinutes} | Minutes a player can wait in the switch queue before removal |`);
    lines.push(`| \`maxUnbalancedSlots\` | ${CFG.maxUnbalancedSlots} | Max player difference between teams to allow a switch |`);
    lines.push(`| \`scrambleLockdownDurationMinutes\` | ${CFG.scrambleLockdownDurationMinutes} | Duration to block switching after a scramble |`);
    lines.push(`| \`scrambleLockdownMinPlayers\` | ${CFG.scrambleLockdownMinPlayers} | Minimum total players to apply scramble lockdown |`);
    lines.push(``);
    lines.push(`### Token System`);
    lines.push(``);
    lines.push(`| Option | Value | Description |`);
    lines.push(`|--------|-------|-------------|`);
    lines.push(`| \`maxSwitchTokens\` | ${CFG.maxSwitchTokens} | Maximum switch tokens a player can hold |`);
    lines.push(`| \`seedTokenBonusAmount\` | ${CFG.seedTokenBonusAmount} | Max bonus tokens per seed round |`);
    lines.push(`| \`seedTokenBonusMinutes\` | ${CFG.seedTokenBonusMinutes} | Minutes of seed presence to earn one bonus token |`);
    lines.push(`| \`seedTokenBonusMinPlayers\` | ${CFG.seedTokenBonusMinPlayers} | Minimum players online for seed time accrual |`);
    lines.push(``);
    lines.push(`### Queue Timeout Switch`);
    lines.push(``);
    lines.push(`| Option | Value | Description |`);
    lines.push(`|--------|-------|-------------|`);
    lines.push(`| \`queueTimeoutSwitchEnabled\` | ${CFG.queueTimeoutSwitchEnabled} | Force-switch on queue timeout instead of removal |`);
    lines.push(`| \`queueTimeoutExtraSlots\` | ${CFG.queueTimeoutExtraSlots} | Extra imbalance slots for timeout-triggered switches |`);
    lines.push(``);
    lines.push(`### Double-Switch`);
    lines.push(``);
    lines.push(`| Option | Value | Description |`);
    lines.push(`|--------|-------|-------------|`);
    lines.push(`| \`doubleSwitchCommands\` | \`${JSON.stringify(CFG.doubleSwitchCommands)}\` | Commands triggering a double-switch |`);
    lines.push(`| \`doubleSwitchCooldownHours\` | ${CFG.doubleSwitchCooldownHours} | Hours before same player can double-switch again |`);
    lines.push(`| \`doubleSwitchDelaySeconds\` | ${CFG.doubleSwitchDelaySeconds} | Delay between first and second team switch |`);
    lines.push(`| \`doubleSwitchEnabledMinutes\` | ${CFG.doubleSwitchEnabledMinutes} | Time window for double-switch after join/match start |`);
    lines.push(``);
    lines.push(`### Liberal Mode`);
    lines.push(``);
    lines.push(`| Option | Value | Description |`);
    lines.push(`|--------|-------|-------------|`);
    lines.push(`| \`liberalSwitchGameModes\` | \`${JSON.stringify(CFG.liberalSwitchGameModes)}\` | Layers/modes with relaxed switching |`);
    lines.push(`| \`liberalSwitchMaxUnbalancedSlots\` | ${CFG.liberalSwitchMaxUnbalancedSlots} | Balance cap during liberal modes |`);
    lines.push(`| \`liberalSwitchBroadcastIntervalMinutes\` | ${CFG.liberalSwitchBroadcastIntervalMinutes} | Minutes between liberal-mode broadcast reminders |`);
    lines.push(``);
    lines.push(`### Dynamic Balance Tolerance`);
    lines.push(``);
    lines.push(`| Option | Value | Description |`);
    lines.push(`|--------|-------|-------------|`);
    lines.push(`| \`dynamicBalanceTolerance\` | ${CFG.dynamicBalanceTolerance} | Enable interpolated extra tolerance below full capacity |`);
    lines.push(`| \`dynamicBalancePlayerFloor\` | ${CFG.dynamicBalancePlayerFloor} | Player count at which max extra slots apply |`);
    lines.push(`| \`dynamicBalanceExtraSlots\` | ${CFG.dynamicBalanceExtraSlots} | Additional imbalance slots at floor player count |`);
    lines.push(``);
    lines.push(`### Server Config (S³ ServerConfigService)`);
    lines.push(``);
    lines.push(`The following values come from the Squad server's \`Server.cfg\` file, read at runtime via S³'s \`ServerConfigService\`. They are NOT Switch plugin options — they are server-level settings that the Switch plugin queries to determine team sizes and whether the native scoreboard team-change command is available.`);
    lines.push(``);
    lines.push(`| Setting | Value | Description |`);
    lines.push(`|---------|-------|-------------|`);
    lines.push(`| \`AllowTeamChanges\` | \`${SERVER_CONFIG.AllowTeamChanges}\` | Whether Squad's native scoreboard team change is allowed |`);
    lines.push(`| \`MaxPlayers\` | \`${SERVER_CONFIG.MaxPlayers}\` | Maximum concurrent players on the server |`);
    lines.push(`| \`NumReservedSlots\` | \`${SERVER_CONFIG.NumReservedSlots}\` | Reserved slots for admins (included in MaxPlayers, not subtracted from team-size cap) |`);
    lines.push(`| **Effective Max** | **${EFFECTIVE_MAX_PLAYERS}** | MaxPlayers (not modified by NumReservedSlots) |`);
    lines.push(`| **Max Team Size** | **${MAX_TEAM_SIZE}** | Half the effective max (rounds down) |`);
    lines.push(``);
    lines.push(`When \`AllowTeamChanges\` is \`false\` (the default), Squad's built-in scoreboard team change is disabled. The Switch plugin replaces the native system because the native team change (every 5 minutes) is too permissive for competitive balanced gameplay.`);
    lines.push(``);

    lines.push(`---`);
    lines.push(``);
    lines.push(`*Built for SquadJS — generated from \`${path.relative(process.cwd(), configPath)}\`*`);
  }

  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────

const outputPath = outputArg
  ? path.resolve(outputArg)
  : path.resolve(__dirname, '..', 'SWITCH_BEHAVIOUR.md');

// Ensure output directory exists
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const content = generate();
fs.writeFileSync(outputPath, content, 'utf-8');
console.log(`✅ Generated: ${outputPath}`);
console.log(`   Config:   ${configPath}`);
console.log(`   Lines:    ${content.split('\n').length} lines written.`);