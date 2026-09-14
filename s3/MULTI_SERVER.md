# Running the suite across two or more Squad servers

One database, one Discord server, several Squad servers. Each SquadJS process declares which server it is, every row that belongs to a particular server carries that id, and the rows that describe a *player* rather than a server stay shared.

This document is the operational half. What the scoping rules are and how export and import behave is in `S3_DEVELOPER_GUIDE.md` sections 10.2.2 and 10.4.

**Status: experimental.** See the last section before you point a second server at a live database.

---

## Declaring which server this is

S³ takes its id from SquadJS's own `server.id`, which is usually what you want. Where two installs both ship `"id": 1` and renumbering one of them would disturb rows other plugins have already written, set `overrideServerID` on the S³ plugin instead. It overrides the id for S³ alone, and every other plugin, including db-log, reads that resolved id rather than declaring an option of its own.

The id has to stay the same for the life of that server. The registry tracks a server by that declaration, so changing it doesn't rename a server, it retires one and introduces another: the old id keeps every row it ever wrote, and the new one starts empty.

If two processes claim the same id, the second refuses to mount rather than interleaving two servers' data. `forceServerClaim` exists for the false positive, because a legitimate port change plus a restart inside the two-minute freshness window looks identical to a genuine collision. Turn it off again once the server is up.

## Aliases

Every server gets a short name for `--server`. The default is the first word of the server name, so "NL Slackers #1" and "Event Server" become `nl` and `event`.

A community that numbers its servers is the case the default can't handle. "Northern Lights #1" and "Northern Lights #2" both want `northern`, and anything longer that keeps both numbers is one edit apart, which the registry refuses on purpose. `srv1` and `srv2` differ in the last character, which is where a typo is least likely to be caught by eye, and it's exactly the pair that ends up typed into a command that scrambles a live game.

So pick them yourself with `!s3 servers alias`. Short, distinct at a glance, and derived from something about the server rather than its position in a list. `main` and `event`. `seed` and `full`. Never a numbered pair.

## Naming a server in a command

`--server <alias>` names one server. `--s <alias>` and `-s <alias>` are the same flag, and all three also take their value after an `=`, so `--server=main`, `--s=main` and `-s=main` work too. That is the whole grammar. It is stripped before the command sees its arguments, so it can go anywhere on the line: `!switch check slacker -s main` and `!switch -s main check slacker` are the same command.

There is no way to say "all servers" and no memory of the last one you named. Both are deliberate. A remembered target turns a typo into a silent assumption about a server you last mentioned some minutes ago, and the sticky value is invisible at the moment it matters — the one where you are about to change something.

A command that changes something on one server requires the selector and refuses without it, naming the servers it would have accepted. A command that only reads is answered by every server, each for itself, and that is why `!switch status` in a two-server community posts two replies. They are not duplicates: each is that server's own answer, and the point of the pair is that you can see where the two differ. Name a server when you want one of them.

The exception is `!switch explain`, which is seven embeds per server and is required to name one. `!elo` reads a single community-wide rating table, so nothing there has a per-server answer to give.

## Upgrading a community

Every process must run the same suite version. This is enforced, not recommended: a process that finds a live sibling on a different version refuses to mount its server-scoped plugins and says so on stderr and in Discord. A mixed pair writes against a schema one of them doesn't know about, and a community-wide command answered by the older process runs a superseded handler. Neither failure announces itself, so mount time is the only moment either can be caught.

The order:

1. Stop every process.
2. Wait about two minutes. A stopped server's registry row stays "live" for that long, and an upgraded process that starts inside the window sees the old version still registered and refuses. The refusal is at mount and doesn't retry, so you'd have to restart it anyway.
3. Start one process and watch it come up. The first one to boot runs the migrations for everybody.
4. Once it's up and migrations are done, start the rest.

Step 3 is the one that gets skipped. "Start all" read as "start them together" puts every process into the same migration lock at once, on the single boot where the migration takes longest. Only one of them will migrate; the others wait, and waiting is fine, but you've given up the ability to see which process is doing what if something goes wrong. Start one, read its log, then start the others.

A half-finished upgrade presents as every process refusing to mount, which reads alarming and is the system working. Finish the upgrade.

## Rolling back

Not every part of this is reversible, and the two halves fail differently.

The columns added to existing tables are additive. Old code ignores a column it doesn't know about, so leaving them in place costs nothing and dropping them is unnecessary. That half rolls back cleanly.

Three tables could not take a column, because the thing that had to change was the primary key and neither SQLite nor a restricted MySQL grant can alter one in place. Those are new tables sitting beside the old ones, and the old ones were abandoned rather than dropped:

| Old table, still present | New table, in use |
|---|---|
| `SwitchPlugin_Settings` | `SwitchPlugin_ServerSettings` |
| `S3_PlayerReconnects` | `S3_ServerReconnects` |
| `S3_PlayerSessions` | `S3_ServerSessions` |

Reverting the code re-points the models at the old tables. The old rows are still there, exactly as they were at the cutover, so the servers come back up on the state they had then. Everything written into the new tables since is stranded: not deleted, not read either. Switch settings changed after the cutover revert to their pre-cutover values, and reconnect and session memory written since is invisible.

That's recoverable in the sense that nothing was destroyed, and unrecoverable in the sense that no supported command puts it back. If you're rolling back after more than a few rounds, take a backup first so the stranded rows can be read out by hand later.

Take a backup before the upgrade too. The pre-migration backup runs automatically, but a rollback plan that depends on a backup you didn't verify isn't a plan.

## Clocks

Run NTP on every host.

Freshness, the migration lock's timeout and the Discord claim reaper all compare timestamps against the *database* clock, so a host whose clock drifts doesn't corrupt anything. What it does is make that host's own timers wrong in ways that don't point at the clock. A server that "keeps going stale" and comes back on its own, or a command that gets answered twice, are both what a couple of minutes of skew look like from Discord.

`!s3 servers` reports each host's skew against the database. Check it when something is behaving oddly and nothing else explains it.

## Options that must match, and options that needn't

Same suite version is enforced. Same *configuration* is not, and once a table is shared several ordinary plugin options stop being local policy. `maxSwitchTokens` used to describe one server's token bucket. It now describes a bucket every server reads and writes.

There are three behaviours, chosen by what a disagreement would actually do.

`maxSwitchTokens`, `switchCooldownMinutes` and `switchCooldownHours` are resolved community-wide. Every process reads one value out of the registry instead of its own config, and the lowest registered value wins. You cannot decline a player's switch because two admins disagree about a cap, and you cannot let the values diverge either, because the lower-capped server resets the regeneration anchor the higher-capped one was accruing against and the player simply stops regenerating. So one value wins, deterministically, and it errs toward the stricter server. Setting `maxSwitchTokens` on one server and not the other doesn't give you two policies, it gives you one that you didn't choose deliberately. The cooldown pair resolves as a pair, because taking the lowest of each key separately invents an interval nobody configured.

`pruneInactivePlayerDays` and `minRoundsForLeaderboard` must agree. Both are deletion predicates against a shared table, and divergence deletes different rows depending on which process ran last. There's no "lowest" that's obviously right, because a retention window is a policy rather than a safety limit. While the values disagree, the housekeeping that deletes on them declines and says so in the log. Switch's inactive-player prune skips, and EloTracker's stale-entry prune skips at mount without taking the plugin down, because two admins disagreeing about a leaderboard threshold is not a reason to stop tracking Elo on a live game. Nothing is deleted, and reads keep answering: a leaderboard uses the strictest value any server registered, so the same command returns the same list whichever process replies to it.

`minPlayersForElo` and `minParticipationRatio` may legitimately differ. Both gate this server's own rounds before anything shared is written, and a 40-player server and a 100-player server have honest reason to disagree. A mismatch is reported and never enforced. The point is to turn an accidental divergence into an argument the admins have on purpose.

All three comparisons run over every *registered* server, not just the live ones. A stopped server still describes what your community's policy is, and it's coming back.

## Confirmations you'll meet

Five commands stop and ask. What each is promising to touch is not the same thing, and the differences matter more on a shared database than they did on one server.

`!s3 db import` writes this server's rows and adopts rows that name no server at all. A sibling's rows are skipped, and the summary tells you whose they were. The two flags that widen it, `--all-servers` and `--remap-server`, each take a second `--confirm`: the first shows you the plan and writes nothing. `--remap-server` merges another server's history into this one and there is no undo.

`!s3 backup restore` cannot be narrowed. The file holds the community's rows and the database is shared, so the confirmation names every registered server. A `.json` restore commits as it goes rather than all at once, which the confirmation says, so a failure partway through leaves the database part old and part new and reports as partly restored rather than as a success. A `.sqlite` restore is a file copy and is refused outright while another server process is live, because overwriting the file underneath a running process corrupts it rather than rolling it back.

`!s3 migrate force` runs pending migrations against the shared schema for everyone at once. Its confirmation token is minted by the process that armed it and accepted only by that process, so the confirm reaches the right one even in a channel several servers are watching.

`!elo reset` wipes ratings, which are community-wide, and stays armed for thirty seconds. `!elo restore` writes a rating file over the same shared table. Both take a token for the same reason `migrate` does.

`!switch wipe confirm` deletes every token balance in the community, typed from one server's admin channel, with no undo. Its confirmation names the registered servers it's about to empty. It sits one keystroke from `clearall`, which is why the confirm word exists.

`!switch clearall` has no confirmation and doesn't need one. It tops every balance up to the cap and deletes nothing, so the worst case is that some players got tokens back. It is still community-wide: it touches every row in the table, not just this server's players, and the cap it tops up to is the resolved community value rather than this process's config, so every server would arrive at the same number.

The separate thing that refuses is the inactive-player prune, which is a deletion predicate rather than a top-up. It declines while `pruneInactivePlayerDays` disagrees between servers and says so in the log. Rows are kept, not lost, which is what makes refusing affordable there and not on the switch path.

## Confirming against the live game

An explicit `--server` protects you from forgetting which server you're talking to. It protects you from nothing at all when you type the wrong one, because a well-formed selector naming the wrong server looks exactly like a correct one.

So a server-scoped command that changes something arms and echoes what is happening on the server it's about to change:

```
About to act on Northern Lights #1 — 78 players, 22m into the round, Gorodok RAAS.
Confirm with: !switch timelimit off a4f2
Expires in 60s.
```

The server is named by its label where there is one, its alias otherwise, and `#<id>` as a last resort.

Read the player count and the elapsed time. Those are always current and they're what actually separates a seeding server from a full one. The layer is supporting detail and can lag a round roll: S³'s layer is stale at `NEW_GAME` and reports the previous round's for a window, so a layer name that looks right is not on its own proof you're aimed at the right server. When the server is seeding the line says so first, because "am I about to scramble the seeding server" is the question this exists to answer.

If the context can't be read, the command refuses rather than executing unconfirmed. A prompt that can't say what it's about to change isn't a confirmation.

None of this happens with one server registered. The echo, the token and the title decoration are all inert until a second row appears.

## Retiring a server

A registry row outlives the process that wrote it, and a retired server's row keeps the community in multi-server mode. Selectors stay required, reads keep broadcasting, and community-wide confirmations keep naming a server nobody is running. Remove it with `!s3 servers forget <alias>`.

It refuses while the row is fresh, so stop the server first and give it a couple of minutes. It also refuses to forget the server you're typing at. Once the last extra row is gone, the surviving process drops back to implicit targeting on its next heartbeat, without a restart.

## If your database user can't run ALTER

A grant of `SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX` is enough for everything except a migration that adds a column. S³ probes what it can actually do rather than reading `SHOW GRANTS`, so it knows before it starts, and it skips the step instead of failing halfway.

What to hand your DBA, in order:

1. `!s3 migrate pending`, which lists what's outstanding.
2. `!s3 migrate preview`, which says what each one does in prose.
3. `!s3 migrate ddl`, which renders the exact statements for your dialect. Only genuinely missing objects are emitted, so it's safe to re-run and safe to hand over twice.

They run that output as a user holding the grant. Then `!s3 migrate force` records the versions against the schema that now exists. Do this once for the community, not once per server.

One thing to warn them about: the probe leaves an empty `S3_GrantProbe` table behind on an install where DROP is also refused, since dropping it is the DROP test. It's re-used rather than recreated, and it isn't debris.

## What has actually been tested

Treat this as experimental.

The scoping rules, the migrations, export and import scoping, the routing and the confirmation surfaces are covered by automated tests running against SQLite, MySQL 8 and PostgreSQL 16, and the migrations are exercised from every prior schema version on all three.

There's also a two-process suite: two real `node` children with different server ids, sharing nothing but one MySQL database, running the shipped services rather than restated models. Each reads back its own game state, win streak, scramble lockdown and Discord message id while the token bucket and the Elo table stay community-wide; two rounds starting in the same millisecond mint different match ids; a scoped export carries one server's rows and none of its sibling's; two processes migrating at once run the migration once between them; one Discord message is claimed by exactly one of them; and fifty round-ends split across both against one shared Elo row land as fifty increments rather than twenty-five. That last one fails as designed when the row lock is removed, so it's testing what it claims to. Two service objects in one Node process are serialised by the process rather than by the database, so none of those cases would have meant anything in-process, and the advisory-lock and connection-pinning defects this design used to have are exactly the kind that survive an in-process suite.

Both processes still run on one host, which means they share a clock and reach the database over loopback. Clock skew between two machines and real network latency are what the freshness windows and the claim race are actually measured against, so treat those as untested. There's no two-host test and no proof from two concurrently live games either. Nothing here has been run against two Squad servers playing at the same time.

So: safe to read, safe to test against a throwaway database, and not something to point at a live community's production data without taking a backup you have verified you can restore.
