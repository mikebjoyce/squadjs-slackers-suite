# Localization

S³ plugins can render their messages in a language other than English. This
document covers configuring it, adding strings, and contributing a language.

Currently shipping: **English (`en`)** and **Portuguese (`pt`)**.

---

## Configuring

Set `language` **once**, on `SlackersSquadServices`. Every S³ plugin picks it up:

```json
{
  "plugin": "SlackersSquadServices",
  "enabled": true,
  "language": "pt"
}
```

That is the whole configuration. Individual plugins have no `language` option
of their own — language is a server-wide property, and there is no coherent
deployment where one plugin speaks Portuguese and the next speaks English.
Putting `language` in another plugin's config block does nothing.

An unrecognised language code logs a warning at mount and falls back to
English. It will not stop your server booting. Messages emitted very early in
startup, before S³ finishes initialising, are always English.

---

## How it works

Strings live in catalogue modules rather than inline in the plugins, and are
looked up by key:

```js
this.verbose(1, this.localize('switch.verbose.rconSuccess', { name, teamID }));
```

`localize(key, vars)` returns the string for the plugin's current language,
substituting `vars` into its placeholders. It never throws:

| Situation | Result |
|---|---|
| Key missing from the active language | Falls back to the English string |
| Key present but left empty (`''`) | Falls back to the English string |
| Key missing everywhere | Returns the key itself |
| A placeholder has no matching `vars` entry | Left in place, not `undefined` |
| An extra `vars` entry with no placeholder | Ignored |

Both `{var}` and `{{var}}` placeholder styles are accepted.

---

## File layout

| File | Contents |
|---|---|
| `s3/utils/s3-i18n.js` | The `localize()` lookup |
| `s3/utils/s3-locale-en.js` | English catalogue (the source of truth) |
| `s3/utils/s3-locale-pt.js` | Portuguese catalogue |
| `s3/utils/s3-locale-merge.js` | Joins translation tiers into one catalogue |

Catalogues are JavaScript modules, not JSON, and they live in `s3/utils/`.
`install.cjs` copies each plugin's `plugins/` and `utils/` directories and
flattens them into a single `squad-server/` layout, so a separate top-level
folder would never reach an installed server. Keep new catalogues in
`s3/utils/`, and namespace the filename (`s3-locale-de.js`) rather than adding
subdirectories — a basename shared across plugins gets renamed at the install
target.

Each catalogue exports two things:

```js
export const MESSAGES = { /* nested by plugin and surface */ };

// Key paths whose translation was machine-written and has NOT been reviewed by
// a fluent speaker. Add a key here in the same commit that adds an unreviewed
// string; delete it once someone who reads the language has checked it. An
// empty array means this catalogue is fully reviewed.
export const UNVERIFIED = [];
```

---

## Adding or changing a string

1. Add it to `s3-locale-en.js` first. English is the source of truth.
2. Key names start with the plugin, camelCase, matching the plugin it belongs
   to (`switch`, `smartAssign`, `teamBalancer`, `eloTracker`,
   `slackersSquadServices`, `s3PluginBase`, `s3DiscordPluginBase`), then a
   surface, then a camelCase leaf: `teamBalancer.verbose.dbStateStale`.
   Surfaces in use are `errors`, `verbose`, `rcon`, `warn`, `broadcasts`,
   `discord`, `commands`, `embeds`, `labels`, and `reasons`. A large surface
   may group one level deeper — `teamBalancer.discord.scramble.*` — but keep
   the plugin segment first and the leaf last.
3. Prefer `{var}` for new placeholders.
4. A translated string must carry exactly the same placeholder set as its
   English original — none added, none dropped, none renamed.
5. If you change what an English string *means*, its existing translations are
   now wrong: add that key to `UNVERIFIED` in every other catalogue.
   Rewording or repunctuating without changing meaning needs no such change.
6. Don't remove a key that still has call sites, or add one with none. The test
   suite checks both.

A key you leave out of a translation catalogue is fine — it falls back to
English. That is preferable to guessing.

---

## Contributing a language

Copy `s3-locale-en.js` to `s3-locale-<code>.js`, translate the values, and open
a PR. Two things make it much easier to accept:

- **Don't rename or restructure keys.** Only the values change.
- **Be honest in `UNVERIFIED`.** If any string came from machine translation
  rather than your own knowledge of the language, list its key path. Nobody
  will think less of a partial catalogue; the maintainers cannot read most of
  these languages, so this list is the only signal that exists.

Partial catalogues are welcome. Untranslated keys fall back to English on their
own, so there is no need to finish everything before submitting.

### Start from a template

Two ready-made starter catalogues live in `s3/locale-templates/`. Copy one to
`s3/utils/s3-locale-<code>.js` and fill in the blanks — each entry carries its
English original on the line above:

```js
// EN: [Switch] Round ending — you will be switched in 15 seconds.
matchendWarning: '',
```

The two are graded by **audience** — who reads the string, and whether they
chose to. Not by where it comes out: a broadcast and the public `!elo`
leaderboard are the same tier, because a random player reads both.

| Template | Strings | Who reads it |
|---|---|---|
| `s3-locale-template-players.js` | **266** | Any player — broadcasts, AdminWarn popups, public `!elo` replies |
| `s3-locale-template-admins.js` | 901 | Your staff — admin-gated commands, scramble and diagnostic reports |

**Start with the player tier.** It is the smallest by a wide margin and the
only one where an untranslated string lands in front of someone who never chose
your server's language. The admin tier is worth doing next; it is the bulk of
what an admin sees day to day, but a handful of people see it rather than a
full server.

**The server log is not a tier, and cannot be translated.** Its text is English
in the source, with no key behind it. A log is read by whoever runs the server,
nearly always while something is broken, and always interleaved with core
SquadJS lines that stay English regardless — so a translated log is harder to
read than an English one, not easier, and it makes an issue report depend on
the reporter's locale. The test suite fails if a `localize()` result reaches
`Logger.*`, `verbose()`, `stderrError()` or `resetStreak()`.

An entry you leave as `''` falls back to English, exactly as a deleted line
would. Neither ever renders blank, so a half-finished catalogue is safe to ship.

#### Using more than one tier

Both fill the **same** `s3-locale-<code>.js`. They are disjoint slices of one
key tree, but several branches — `teamBalancer`, `switch` — appear in both
tiers, so pasting the second template into the same object literal would
silently drop the first copy of that branch. Nothing errors; that tier just
falls back to English. Merge instead:

```js
import mergeMessages from './s3-locale-merge.js';

export const MESSAGES = mergeMessages(
  { /* the player template's object */ },
  { /* the admin template's object  */ }
);
```

A catalogue that covers one tier needs none of that — keep the plain
`export const MESSAGES = { ... }` the template ships with.

Both templates are generated. If you add or rename a key, regenerate them:

```
node tools/make-locale-templates.mjs
```

The test suite fails if the committed templates are stale, so they cannot
silently drift from the catalogue, and it checks that no key lands in two tiers
— which would make `mergeMessages` pick a winner instead of joining them.

### Don't sort by surface name — several of them lie

The split above is computed from the source, not from the key names, because
the names are not a reliable guide:

| Surface | Sounds like | Actually |
|---|---|---|
| `warn` | a log warning | **in-game popup** (`AdminWarn`) — and it holds both audiences |
| `errors` | user-facing errors | **either** — the ones a person sees; the rest are English log text with no key |
| `reasons` | something a player is told | **admin** — mostly scramble diagnostics |
| `embeds` | one audience | **both** — TeamBalancer's go to a staff channel, the Elo leaderboard does not |

Audience is not readable off the surface either. `switch.warn` holds the reply
any player gets from `!switch` *and* the reply only an admin can provoke, and
both arrive as the same popup.

So each key is classified from its call site: can an ordinary player reach that
line, decided by the admin gates the code already enforces — a handler that
returns unless `chat === 'ChatAdmin'`, an enclosing `if (isAdminChannel)`, an
`if (!isAdmin) { … return; }` guard earlier in the same `case`, or a Discord
channel that is a staff channel. The rejection text inside a guard is the
exception that proves the rule: a *player* is the one who trips "you must be an
admin", so those go back to the player tier.

The same walk is what finds a string heading for the log. That is not a tier —
it is a defect, and the suite reports the file, line and sink so it can be
turned back into an English literal.

When in doubt, trust the template over the name. The templates are regenerated
from that analysis on every run, and the test suite pins a sample of the
verdicts so a classifier that stops reading one of those gates fails the build.

If you are adding a plugin that calls `localize()`, extend `S3PluginBase` and
call `this.localize(key, vars)`. Do not import `s3-i18n.js` directly and do not
declare a `language` option — the base class reads the language from S³, and
either of those would bypass it and render English regardless of config. The
test suite asserts both.

---

## What is not localized

Anything a machine reads or a maintainer greps stays in English: config and
option names, database tables and columns, event names, plugin and class names,
diagnostic codes, and version strings.

**Values written to storage stay in English too**, even when they read like
prose. TeamBalancer's round report stores `winner: 'Draw'`, `gameMode:
'Unknown'` and `scrambleCondition: 'None'`; the scramble JSON report stores
`layerName` and player names the same way. Translating those would rewrite the
stored data and break every query and export that compares against the English
value — including historical rows written before the language changed. The test
that a string is display text, not data, is simple: if anything other than a
human ever reads it back, leave it alone.

**Text a later read parses is data too**, even when nothing writes it to a
database. `!switch stats` fetches its own past round-summary embeds back out of
Discord history and finds them by their exact title, then reads counts out of
the field names and the `**Mode:**` lines — so that embed is a storage format
that happens to be legible, and every label in it stays English. The same goes
for the column headers in `!s3 switches export`: a saved spreadsheet has to keep
finding its column. Where one table feeds both a parser and a reader, the row
carries two names — a `label` for the export and a `key` for the embed — rather
than picking a side.

Pluralization, grammatical gender, and locale-specific date or number
formatting are not supported. Where a string would need them, the English is
written to avoid them.

### Coverage

Every player-facing and admin-facing string in the suite is extracted: the
plugin files, and the whole of the `utils/` layer behind them — Switch's
command, queue, output and explain helpers; TeamBalancer's command handlers,
diagnostics and Discord embed builders; the Elo tracker's command and Discord
helpers; and S³'s own command, report, diagnostic and migration helpers. That
is the round-end broadcasts, every in-game command reply, and every embed an
admin reads in Discord.

A util reaches `localize()` through the plugin instance it was handed
(`plugin.localize`, `tb.localize`), never by importing `s3-i18n.js` — a direct
import would bypass the configured language and render English forever while
looking correctly wired. Where a helper had no route to the instance, the
instance was threaded in rather than worked around.

What is left in English is left there deliberately, and each case is commented
where it sits: the `!switch stats` round-summary embed and the export column
headers described above, the schema-drift note S³ writes into its own
schema-version row, `'Unknown'` and similar fallbacks inside player and layer
records, the command tokens in help text, and the verbose-relay header on a
watch embed whose body is raw SquadJS log output.

---

## Tests

```
node s3/testing/test-i18n.js
```

This checks key and placeholder parity across catalogues, that every
`localize()` call site resolves to a real key and supplies the variables its
template needs, that no key is left without a call site, that `UNVERIFIED`
contains no stale paths, and that the fallback behaviour above holds.

It also runs the real `lang` getters — lifted out of the shipped source rather
than reimplemented — end to end, so a configured language provably reaches a
consumer plugin, and asserts that no plugin declares its own `language` option
or imports `s3-i18n.js` directly. Both of those would render English forever
while looking correctly wired.

It checks that every `localize()` call has its plugin handle in scope. A call
added to a helper that never received the instance parses cleanly and throws
`ReferenceError` the first time that branch runs, which for an error path can
be long after the deploy.

Finally it checks the starter templates: that they are current with the
catalogue, that between them they cover every key exactly once and no key twice,
that each announces its tier, and that none ships a pre-filled value.

It runs as part of the full suite (`node testing/run-all-tests.js`).
