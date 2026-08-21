# Team Balance & Scrambling — Summary for the Admin Team

**Written:** 2026-08-21
**What this is:** a plain-language writeup of everything we tested over the last
few days about team balance and the auto-scrambler, what we found, and what we
think should change. There's a much more technical version of this for whoever
ends up writing the code (`analysis/SCRAMBLE_BALANCE_INVESTIGATION.md` and
`analysis/HANDOFF_experimental_balance_tuning.md`) — this doc skips the math and
just tells you what we did, what it means, and what we're recommending.

---

## The short version

We went looking for ways to make the average ticket margin (how lopsided games
are) smaller. We tried a lot of things. Most of them didn't help — not because
we did them wrong, but because **the game itself is just noisy**: who wins by
how much is mostly decided by things that happen *during* the round (a good
push, a bad call, momentum), not by anything we can measure or fix beforehand.

Two things *did* turn up real, useful improvements, and neither is turned on
yet:

1. **Scramble more often, earlier.** Right now we only scramble about 1 in 4
   games. We found a way to catch unbalanced lobbies *before* the round even
   starts, instead of waiting for a stomp to happen first.
2. **Account for clan groups, not just skill.** A group of 4+ friends from the
   same clan playing together punches noticeably above their individual skill
   ratings. The scrambler currently has no idea this happens.

We'd also recommend changing what we consider "success" — average ticket
margin is the wrong number to chase, because it turns out to have a floor we
can't get under no matter what we do to the balancer. Whether games are
*close* (a coin-flip outcome) is a much more fixable target, and it's the
thing our two recommendations above actually move.

---

## What we tested, and what we found

### 1. Making the scrambler shuffle more people around

**Question:** does moving more players per scramble make teams more even?
**Answer: no.** We replayed hundreds of real past games through the actual
scrambler code at different settings — shuffling as few as 30 players and as
many as 66 — and the resulting balance came out basically identical every
time. The scrambler already gets teams as even as they're going to get; moving
more people around doesn't buy anything extra. **Not worth touching.**

### 2. A weird hardcoded rule in the scrambler

We found a rule in the code that forces a bigger shuffle whenever the teams
are "close enough" before scrambling — but the definition of "close enough" it
uses turned out to sit right in the middle of normal games, not at some rare
edge case like the comment in the code suggested. It's a harmless oddity, not
a bug worth fixing — per point 1 above, it doesn't actually change the outcome
either way.

### 3. Does scrambling actually help?

**Yes, clearly.** We compared games that got scrambled after a blowout against
similar games that didn't. Scrambled games finished with meaningfully smaller
ticket margins — roughly **22–30 fewer tickets on average**. The scrambler
works. The question is just how often it gets used (see #5).

### 4. Do players leave more after a scramble?

**No.** There's a common worry that scrambling annoys people into leaving.
We checked: roughly 40-45% of any round's players are different from the
previous round regardless of whether it was scrambled or not. If anything,
scrambled rounds lose *slightly fewer* people, not more. **This isn't a real
downside.**

### 5. How often do we actually scramble?

**Only about 1 in 4 eligible games (26%).** This is the single biggest
untapped opportunity we found. Every trigger we currently use only fires
*after* a round has already gone lopsided (a big win streak, a blowout in one
round, etc.) — it reacts to damage that's already been done instead of
preventing it. See "What we're suggesting" below.

### 6. Tweaking how the scrambler scores "balanced"

The scrambler currently blends two measurements (average skill, and top-15
skill) when deciding how to shuffle. We tried different blends. The best
blend we found is only very marginally better than what's already live, and
even the *best possible* version of this knob only ever explains a tiny
sliver of what actually decides ticket margin. **Not worth the engineering
effort to change.**

### 7. SmartAssign (the system that quietly moves people between teams)

We looked into why about 13.5% of its move attempts fail. Almost all failures
(95%) happen in the 1-4 minute window right after a round ends. **The cause:
the Squad game engine itself blocks team-change requests during the
post-round faction-vote phase, as an anti-cheat/anti-abuse measure** — it's
an engine-level restriction, not a bug in SmartAssign or an artifact of map
loading. **This is working as intended, and there's nothing to fix.**

### 8. Squads vs. Clans

This was one of the more interesting findings. We checked whether **in-game
squads** (organized groups formed in the squad UI, could be total strangers)
carry any extra strength beyond what their individual skill ratings suggest.
**They don't** — a squad of 9 randoms performs exactly like their ratings
predict, no bonus, no penalty.

**Clan groups are a completely different story.** When 4 or more players from
the same clan tag are on one team together, that team wins noticeably more
than their skill ratings say they should — the more clan-mates stacked
together, the bigger the effect. This checks out against outside research too
(a Microsoft study on Halo found the same pattern for premade groups in that
game). **This is real, and it's currently invisible to our balancer.**

*(One clarification: we double- and triple-checked this wasn't just an
artifact of unrated/new players being scored as exactly average — that's a
real separate effect we controlled for, and the clan effect held up anyway,
and actually got *stronger* once we measured it the right way.)*

*(This is "invisible to the balancer" specifically for groups wearing a clan
tag. See #14 below — we also checked for friend groups who play together
constantly without a tag, and found real ones. The clan tag is currently the
stronger, more reliable signal of the two, but it's not catching everyone.)*

### 9. Should the house clan (NL) get the same treatment?

**No, and we checked carefully.** NL fields much bigger groups than anyone
else, but stacking more NL players together does *not* make a team
outperform, once you control for the fact that NL members are regulars with
well-established (accurate) skill ratings. The likely explanation: everyone
else's clan bonus shows up because their coordination *isn't* already priced
into their individual ratings (they don't play here as often), but NL plays
here constantly, so the system has already learned how good they really are.
**NL should stay excluded from any clan-grouping change**, same as it is
today.

### 10. Should the scaling be based on how rarely a clan visits, instead of a hardcoded list?

We tested a nicer, more "automatic" version of point 9 — instead of a manual
list of exempt clans, scale the bonus by how rarely a group plays here (so any
new regular clan would auto-exempt itself over time). **This didn't hold up**
— the effect isn't cleanly related to how often a group visits. **We're
keeping the manual list, not replacing it with a formula.**

### 11. Weighting the scrambler toward players likely to stay the whole round

**Idea:** since ~40% of a lobby turns over by round end, why not balance
around the people likely to actually finish the round, instead of everyone
equally? We built this and tested it two ways. Predicting who leaves turned
out to work well on its own. But when we actually plugged that into the
scrambler's decision-making and replayed it against real games, **it made
outcomes slightly worse, not better** (confirmed statistically, not just
noise). The likely reason: optimizing for a prediction about who'll leave
pulls the scrambler's choices away from optimizing for the actual thing it's
graded on. **Built, tested, and intentionally left off. Don't turn this on.**

### 12. Do we need to fix how "unrated" (brand new) players are scored?

There's a small, real effect here, but it's tiny once you also account for
how *confident* the system already is in each player's rating (which it
already is, automatically). **Not worth separate engineering effort.**

### 14. Detecting friend groups that don't wear a clan tag

Some regulars clearly play together constantly without ever joining a clan.
We built a system that learns this from squad history instead of relying on
tags. It found real groups — including some the tag system completely
misses. It's a promising secondary signal, but it needs more history to
"warm up" and isn't as strong as the clan-tag signal yet. **Worth revisiting
later, not now.**

### 13. A tech-chat idea: just lower the thresholds for reactive scrambling

Someone suggested lowering the bar for the *existing* triggers (smaller
blowout needed, fewer consecutive wins needed, etc.) so we scramble more
often. We tested this properly. It would raise how often we scramble by a
similar amount to point 5's idea — from about 1-in-4 games to somewhere
between roughly 1-in-3 and just under 1-in-2 — but it has the same core
weakness as every reactive trigger: **it only fires after a round has already
gone badly.** It trades "wait for a big stomp" for "wait for a smaller
stomp," but it never prevents the bad round from starting unevenly in the
first place. **We recommend the predictive approach below instead — it does
everything this idea was trying to do, better.**

### 14. Tuning the skill-rating math itself based on how big the win was

**Idea:** instead of just recording win/loss, give bigger rating swings for
bigger blowouts, on the theory that better-tuned ratings would help predict
(and prevent) big margins. We tested this directly. It does make the ratings
slightly better at predicting *who wins* — a small, real, separate benefit.
**It does nothing for ticket margin** — the correlation between skill gap and
final ticket margin stayed flat no matter how aggressively we tuned it. This
is the third independent test this investigation has run that lands on the
same wall: **ticket margin has a ceiling that rating math cannot get under,**
because the margin is decided by in-round events, not pre-round skill.

---

## Why ticket margin won't go much lower, no matter what we do

We checked this from every direction we could think of: how skilled each team
is, how many players are online, which map is being played, how long the
round runs, and how aggressively the rating math reacts to blowouts. Put all
of that together and it explains **less than 5% of why one round ends 250-0
and another ends 60-40.** The other 95%+ comes down to what actually happens
once the round starts — a good push, a bad call, momentum swinging — which
nothing measurable beforehand can see coming.

That's not a failure to find the right lever. We looked hard, and repeatedly
confirmed the same result through several completely different tests. It
means **average ticket margin is the wrong number to optimize.** How often
games are genuinely close (a real toss-up, not a foregone conclusion) *is*
something we can move, and it's exactly what the two recommendations below
target.

---

## What we're suggesting

### 1. Scramble based on the average Elo difference between the teams

This happens at the exact same point scrambles already happen today —
nothing changes about when or how the scrambler runs. Today, the scrambler
only fires when one of three specific things happens: a big single-round
blowout, a win streak, or too many consecutive wins. **It never just checks
the average Elo difference between the two teams and asks "is this too
lopsided?"** — this adds that as a fourth, simple check: if the average Elo
gap between teams is bigger than a threshold we've already validated
elsewhere in the code, scramble. If it's not, leave it alone (touching
already-close lineups risks making things *worse* about 1 in 5 times).

**Estimated effect:** this should meaningfully raise how many games get
scrambled (roughly from 1-in-4 today to somewhere between 1-in-3 and just
under half, based on the closest comparable test), catching imbalance that
today's three trigger conditions simply don't check for. We can't promise an
exact ticket-margin number in advance — that relationship is real but weak,
as explained above — so this needs to be watched for a few weeks after it
ships to confirm it's actually landing.

### 2. Add clan-group awareness to the scrambler

**Correction: this still needs to be built.** Our own notes had previously
said this was already implemented behind an off switch — that turned out to
be wrong, and we've now double-confirmed it two ways: the switch isn't in the
actual code, and re-running the same past test against today's code shows it
doing nothing (the "before/after" numbers below come out identical either
way now). A past testing pass built and measured the real thing, but it was
never actually saved into the scrambler file, so what exists today is the
*measurement*, not the feature. It needs to be (re)written before it can be
turned on.

What it would do: today the scrambler keeps a clan's players together as a
group when shuffling teams (so a clan doesn't get split apart), but it has no
concept that a stacked clan group is *worth more* than the same number of
random players — it treats them as equally strong. This would add that: once
4 or more players from the same non-house clan are grouped on one team, treat
that as a real strength bonus, the same way the scrambler already accounts
for individual skill.

**Estimated effect, from the earlier measurement (needs to be re-confirmed
once the feature is actually rebuilt):** replayed against ~800 real past
games, this raised the share of games with **perfectly even clan groups from
47.5% to 58.0%** — a real, ten-point swing — for essentially no cost (barely
any change in overall skill balance or how many players get moved). It
improved 96 out of 793 games and made only 2 worse. Same caveat as
recommendation 1: we couldn't cleanly measure whether this translates into
*ticket margin* specifically, so it should be watched after shipping, not
assumed — and now, additionally, the whole result needs re-validating once
the code actually exists again.

### 3. Change what we call "success"

Stop tracking average ticket margin as the main balance number — it has a
floor we can't get under. Track **how often games are close** instead (a
real toss-up rather than a foregone conclusion). That's the number our two
recommendations above actually move, and it's a fairer measure of whether
the balancer is doing its job.

---

## What we're explicitly NOT changing (and why)

- **How many players get shuffled per scramble** — already at its ceiling, more churn changes nothing (#1)
- **The scrambler's skill-blend formula** (average vs. top-15 skill) — marginal at best, not worth the engineering time (#6)
- **SmartAssign's failure handling** — the failures are an engine-level anti-abuse restriction during the post-round vote phase, not a bug (#7)
- **Lowering the existing blowout/streak thresholds** — same idea as our #1 recommendation, but strictly worse (#13)
- **Weighting the scrambler toward players likely to stay the round** — built, tested, made things worse (#11)
- **The house clan (NL) exemption** — correct as-is, tested and confirmed (#9, #10)
- **Rating-math tuning based on blowout size** — real benefit for predicting winners, zero benefit for ticket margin (#14)

---

## Bottom line

We can make games *close* more often. We cannot make blowouts smaller once
they've started, and no amount of tuning the balance math changes that. Ship
the two recommendations above, watch the real numbers for a few weeks, and
start reporting "how often are games close" instead of "average ticket
margin" as the thing we're trying to improve.
