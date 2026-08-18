# Switch Plugin — Behaviour Reference

> **Reference document.** Describes how team switching works on this server based on the configuration in `switch\tools\behaviour-config.json`. If your server administrator has changed any settings, the live behaviour may differ.

---

## How Team Switching Works

Squad's native team change command is disabled on this server. **`!switch`** is how you change teams. The plugin enforces balance rules to keep teams fair while still allowing you to play with your friends.

### Commands

| Command | Description |
|---------|-------------|
| `!switch` | Request a team change |
| `!switch check` | See your eligibility and token balance |
| `!switch cancel` | Leave the switch queue |

*All three commands are typed in all, team or squad chat.*

### Key Rule

- Switching from the **bigger team** to the **smaller team** is usually allowed.
- Switching from the **smaller team** to the **bigger team** is only allowed if the gap stays within the balance limit (see below).

---

## Balance Rules

A switch is allowed if it does not make the teams too lopsided. The rules depend on how many players are on the server.

### What the numbers mean

The **gap** is the difference in player count between the two teams.

Example: Team **1** has **42** players, Team **2** has **38**. The gap is **4**.

**Tolerance** is how much extra gap the server allows beyond the base limit of **1**. At low population, more tolerance is given so switches are easier. As the server fills up, tolerance shrinks to keep teams fair when it matters most.

### Tolerance Table

| Players | Extra Tolerance | Max Allowed Gap |
|---------|----------------|-----------------|
| 1-87 | 3 | 4 |
| 88-92 | 2 | 3 |
| 93-99 | 1 | 2 |
| 100+ | 0 | 1 |

### Example

With **88-92** population, the max allowed gap is **3**.
- If the bigger team leads by **3**, a switch from the bigger team is allowed (gap shrinks to **1**).
- A switch from the smaller team is **not** allowed (gap would grow to **5**, exceeding the max of **3**).

### Hard Cap

Each team can hold at most **50** players (half of **100** total slots, including **2** reserved).
You cannot switch to a team that is already at **50**.

---

## Switch Tokens

Each **`!switch`** costs **1** token. Tokens refill automatically over time. You are not locked out for a full cooldown after a single switch.

### Token Pool

- Maximum tokens: **2**
- Refill time: **1.75 hours** per token

### How It Works

Tokens refill one at a time, independently. With **2** tokens saved, you can switch up to 2 times before waiting for a refill. This gives you flexibility without allowing unlimited switching.

### Seed Bonus

During seed rounds, you earn **+1** bonus token for every **20** minutes you are present.
You can earn up to **1** bonus token per seed round.

If the seed round ends before you have banked a full 20 minutes, you still get **+1**
as long as you are **still on the server when the round ends**. Leave early and you
get nothing for that round — though anything you already earned is yours to keep.

Bonus tokens stack above your normal cap of **2**, up to a hard ceiling of **3** tokens.
Once you are at 3 you stop earning, however many seed rounds you play, until you spend
one and drop back below the ceiling.

### Checking Your Balance

Use **`!switch check`** to see your current token balance and when your next token refills.

---

## Time Window & Queue

You can only use **`!switch`** during a limited window. If teams are currently full, you will be placed in a queue.

### Time Window

- You have **10 minutes** after joining the server
- **OR** after the match starts, whichever gives you more time.
- If you join mid-match, your personal time window starts when you joined.
- Once both windows close, **`!switch`** is unavailable for the rest of the match.

### The Queue

- If no switch slot is immediately available, you are placed in a queue.
- The queue holds your spot and processes switches as soon as a slot opens.
- For example, when someone on the other team also types **`!switch`**, that creates room for you to move.
- The queue checks for available slots every few seconds as the server updates its player counts. It will not act on incomplete or stale data.
- Note: the in-game scoreboard can be slow to update. The queue uses its own player count tracking and is more reliable than the scoreboard.
- You have **15 minutes** in the queue before your request expires.

If your queue request reaches the **15-minute** time limit without a normal slot opening, the system will force-switch you with a slightly relaxed balance limit. This is a fallback so you are not left stranded. The normal balance rules are your best path.

Use **`!switch cancel`** to leave the queue at any time.

---

## Scrambles & Switching

A scramble is when the server shuffles players to rebalance teams after one-sided rounds. After a scramble, switching is temporarily locked.

### What a Scramble Does

- The scrambler keeps squads and clans together. Your squad and clan group will not be split up.

- When a clan group is kept together, the rest of their squad is pulled along with them. No one gets left behind.

### Post-Scramble Lockout

- After a scramble, **`!switch`** is locked for all players for **30 minutes**.
- This prevents players from undoing the scramble by switching back.
- The system is designed to help you play with your friends, even when things go wrong. If a scramble fails to move you, or you reconnect to the wrong team, your restrictions are cleared so you can fix it yourself.

### Lockout Exceptions

You are **NOT** locked after a scramble if:
- You are still within your **10-minute** join/match window.
- You were already in the switch queue before the scramble fired.
- The scramble **failed to move you** (RCON error). Your scramble lock is cleared and you may receive a **+1 switch token** so you can use `!switch` immediately to rejoin your group.
- The scramble failed to keep your squad or clan together. In this case, you are given extra leniency to switch back to your group when your join/match window opens.

### Reconnecting After a Scramble

- If you disconnect and reconnect to a different team after a scramble, your switch restrictions (including the scramble lockout) are cleared.
- You can use **`!switch`** immediately to return to your previous team.
- If you reconnect during a faction vote, an ignored game mode, or passive mode, your scramble lock is still cleared so you are not stranded. Use `!switch` when the round starts.

---

## Special Cases

Some game modes and situations change how the normal rules apply.

### Seed & Jensen Rounds

During **Seed & Jensen** rounds, switching is relaxed:
- **No time window limit.** Switch at any point during the round.
- **No token cost.** Switches do not consume tokens.
- **More permissive balance limit.** Up to **6** players difference is allowed instead of the normal tolerance.

### Faction Vote (Between Rounds)

- During the faction vote screen between rounds, **`!switch`** is unavailable.
- The queue is paused. When the next round begins, the queue is cleared.
- You will need to re-queue if you still want to switch.

---

## Tips for Playing With Friends

The system is designed to help you end up on the same team as your friends. Here is how to make the most of it.

**1. Switch early.** Your **10-minute** window starts when you join. Do not wait until the last minute.

**2. Save a token.** With **2** tokens, you can switch more than once before waiting for a refill. This gives you flexibility if you need to switch multiple times in a session.

**3. Use seed rounds.** Seed and Jensen rounds have no token cost and no time limit. Use this time to position yourself on the right team for free.

**4. Check before you act.** **`!switch check`** tells you exactly what is blocking you: time window, tokens, scramble lock, or balance. This helps you make an informed decision.

**5. Squads and clans stay together.** The scrambler preserves squads and clan groups. Even if a scramble fires, your group will not be split up.

**6. The system has your back.** Even when things go wrong (a scramble fails to move you, or you reconnect to the wrong team), your restrictions are cleared and you may receive bonus tokens so you can fix it yourself. You are never permanently stranded.

---

## Configuration Values

The following table lists every configuration option with the value used to generate this document. These come from the JSON config file — edit that file and re-run the generator to preview how changes affect the player-facing rules. If your server admin has changed any settings, the live behaviour will differ.

### Core Switch Behaviour

| Option | Value | Description |
|--------|-------|-------------|
| `commandPrefix` | `["!switch","!change"]` | Command prefix(es) to trigger switch |
| `switchCooldownHours` | 1.75 | Hours per-token refill interval |
| `switchCooldownMinutes` | 0 | Minutes per-token refill interval (overrides hours if > 0) |
| `switchEnabledMinutes` | 10 | Time window (minutes) after join/match start to request a switch |
| `queueTimeoutMinutes` | 15 | Minutes a player can wait in the switch queue before removal |
| `maxUnbalancedSlots` | 1 | Max player difference between teams to allow a switch |
| `scrambleLockdownDurationMinutes` | 30 | Duration to block switching after a scramble |
| `scrambleLockdownMinPlayers` | 60 | Minimum total players to apply scramble lockdown |

### Token System

| Option | Value | Description |
|--------|-------|-------------|
| `maxSwitchTokens` | 2 | Maximum switch tokens a player can hold |
| `seedTokenBonusAmount` | 1 | Max bonus tokens per seed round, and the amount by which seed bonuses may exceed `maxSwitchTokens` |
| `seedTokenBonusMinutes` | 20 | Minutes of seed presence to earn one bonus token |
| `seedTokenBonusMinPlayers` | 0 | Minimum players online for seed time accrual |
| `pruneInactivePlayerDays` | 3 | Days unseen before a player's cooldown row is pruned |

### Queue Timeout Switch

| Option | Value | Description |
|--------|-------|-------------|
| `queueTimeoutSwitchEnabled` | true | Force-switch on queue timeout instead of removal |
| `queueTimeoutExtraSlots` | undefined | Extra imbalance slots for timeout-triggered switches |

### Double-Switch

| Option | Value | Description |
|--------|-------|-------------|
| `doubleSwitchCommands` | `["!bug","!stuck","!doubleswitch"]` | Commands triggering a double-switch |
| `doubleSwitchCooldownHours` | 0.5 | Hours before same player can double-switch again |
| `doubleSwitchDelaySeconds` | 1 | Delay between first and second team switch |
| `doubleSwitchEnabledMinutes` | 10 | Time window for double-switch after join/match start |

### Liberal Mode

| Option | Value | Description |
|--------|-------|-------------|
| `liberalSwitchGameModes` | `["Seed","Jensen"]` | Layers/modes with relaxed switching |
| `liberalSwitchMaxUnbalancedSlots` | 6 | Balance cap during liberal modes |
| `liberalSwitchBroadcastIntervalMinutes` | 8 | Minutes between liberal-mode broadcast reminders |

### Dynamic Balance Tolerance

| Option | Value | Description |
|--------|-------|-------------|
| `dynamicBalanceTolerance` | true | Enable interpolated extra tolerance below full capacity |
| `dynamicBalancePlayerFloor` | 85 | Player count at which max extra slots apply |
| `dynamicBalanceExtraSlots` | 3 | Additional imbalance slots at floor player count |

### Server Config (S³ ServerConfigService)

The following values come from the Squad server's `Server.cfg` file, read at runtime via S³'s `ServerConfigService`. They are NOT Switch plugin options — they are server-level settings that the Switch plugin queries to determine team sizes and whether the native scoreboard team-change command is available.

| Setting | Value | Description |
|---------|-------|-------------|
| `AllowTeamChanges` | `false` | Whether Squad's native scoreboard team change is allowed |
| `MaxPlayers` | `100` | Maximum concurrent players on the server |
| `NumReservedSlots` | `2` | Reserved slots for admins (included in MaxPlayers, not subtracted from team-size cap) |
| **Effective Max** | **100** | MaxPlayers (not modified by NumReservedSlots) |
| **Max Team Size** | **50** | Half the effective max (rounds down) |

When `AllowTeamChanges` is `false` (the default), Squad's built-in scoreboard team change is disabled. The Switch plugin replaces the native system because the native team change (every 5 minutes) is too permissive for competitive balanced gameplay.

---

*Built for SquadJS — generated from `switch\tools\behaviour-config.json`*