# How SmartAssign Works: A Guide for Server Admins

SmartAssign replaces Squad's basic "lowest population" auto-assign feature with a much smarter system. Its primary goals are to create highly competitive matches, keep disconnected players with their squads, and ensure team sizes remain fair—especially when the server is full.

This guide explains exactly how SmartAssign makes its decisions, written plainly so you can understand its behavior without needing to read the code.

---

## The Decision Process (Step-by-Step)

Every time a player joins the server, SmartAssign runs them through a rapid decision checklist to figure out which team they belong on. You can think of it like a flow chart:

### 1. Is this a Seed match?
* **Yes:** Ignore the player completely. Let them join whatever team they want natively.
* **No:** Continue to Step 2.

### 2. Is the Server Full? (50 vs 50)
* **Yes:** If both teams are completely maxed out at 50 players, the plugin takes no action. It lets the game handle the player natively to prevent overfilling teams or generating impossible move commands.
* **No:** Continue to Step 3.

### 3. Did the player just crash or disconnect? (Reconnect Memory)
* **Yes:** The system checks if placing them back on their *previous* team would cause a massive population imbalance (e.g., making it 48 vs 42).
  * If it's safe: **Assign them to their previous team immediately.**
  * If it would break the server balance: Treat them like a brand new player and move to Step 4.
* **No:** They are a new player. Continue to Step 4.

### 4. Hard Population Check
The system strictly limits how lopsided teams can get based on how full the server is.
* **Is the server at 94+ players?** Teams cannot be more than **1 player** apart.
* **Is the server at 88-93 players?** Teams cannot be more than **2 players** apart.
* **Is the server at 80-87 players?** Teams cannot be more than **3 players** apart.
* **Are there less than 80 players?** Teams can drift up to **4 players** apart to allow for better skill balancing.
* **Decision:** If putting the player on Team 1 violates these rules, **force them to Team 2.** Otherwise, move to Step 5.

### 5. Skill Balancing (The "Mu" Score)
If the player isn't a reconnect, and both teams have room for them, the algorithm decides where they go based on their **Skill Rating (Elo/Mu)**.
* The system asks: *"Which team would benefit most from this player's skill to make the match as perfectly even as possible?"*
* **Decision:** Assign the player to the team that creates the most balanced match. 
* *(See "How Skill Balancing Works" below for more details).*

---

## Passive Mode

Sometimes you want to observe how your server behaves without SmartAssign making any decisions. **Passive Mode** (`enableSmartAssign: false`) lets you do exactly that.

In Passive Mode:
* The plugin **does not** run the assignment algorithm for joining players
* The plugin **does not** log `ASSIGNMENT` events
* The plugin **only** logs real server events: `JOIN`, `LEAVE`, `TEAM_CHANGE`, `MOVE_SUCCESS`, `MOVE_FAILED`
* All other features (reconnect memory, lifecycle logging, round snapshots) remain active

This is useful for:
* **Validating log formats** before going live
* **Monitoring server activity** without any auto-assignment intervention
* **Troubleshooting** by observing natural player behavior

Simply set `enableSmartAssign: false` in your config to enable it.

---

## Understanding The Core Rules


### Reconnect Memory & Grace Allowances
Squad crashes happen. When they do, players shouldn't be punished by being auto-balanced to the enemy team, losing their squad, and abandoning their friends. 

To solve this, SmartAssign gives returning players a **Bonus Allowance**. Even if their old team is slightly bigger than the enemy team, the system bends the rules (allowing up to a 2-player difference on a full server, or a 4-player difference on a low-pop server) just to get them back to their squad.

### How Skill Balancing Works
When placing a fresh player, SmartAssign relies on the `EloTracker` plugin to provide a skill rating for everyone on the server. To calculate the "fairest" team for the new player, it looks at two things:

1. **Average Skill:** Are the average players on Team 1 roughly as skilled as the average players on Team 2?
2. **Total Skill (Sum):** Even if the averages are similar, does one team have a massive stockpile of veteran players?

The algorithm calculates what the teams would look like if the new player joined Team 1 versus Team 2. It heavily prioritizes keeping the **Average Skill** gap small, but also factors in the **Total Skill** gap (scaling it dynamically so it works just as well with 30 players as it does with 100). The player is assigned to whichever side yields the lowest combined score.

### Background Enforcer (The Retry Queue)
Squad's server engine is notoriously buggy. Sometimes, if you tell the server to move a player while they are still on a loading screen, the server ignores the command. 

To combat this, SmartAssign uses a background **Retry Queue**. If it decides a player needs to be on Team 2, but the game fails to move them, SmartAssign will keep retrying rapidly (every 150ms for up to 3 seconds) until it successfully places them on the right team. This guarantees that the algorithm's choices are actually respected by the game even if the engine is busy.

---

## Summary
In short, SmartAssign:
1. **Ignores** seeding rounds.
2. **Prioritizes** putting crashed players back with their squads.
3. **Enforces** strict population limits so games are never hopelessly lopsided.
4. **Balances** the remaining players mathematically using their actual skill ratings.
5. **Guarantees** moves happen by constantly retrying failed commands.