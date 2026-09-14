/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       ELO DISCORD LEGACY EMBED FALLBACK TEST                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Covers EloDiscord.sendDiscordMessage()'s behaviour on a discord.js too
 * old to accept an `embeds` array — the same regression fixed in
 * s3/testing/test-discord-legacy-embeds.js, duplicated here because
 * EloTracker keeps its own copy of the sender rather than importing S³'s.
 *
 * ─── ORDER MATTERS ────────────────────────────────────────────────
 *
 * legacyEmbedMode is module state, sticky once a legacy host is detected.
 * The modern-host case has to run first.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node elo-tracker/testing/test-elo-discord-legacy-embeds.js
 *
 */

import assert from 'node:assert/strict';

import { EloDiscord } from '../utils/elo-discord.js';

function modernChannel() {
  const sent = [];
  return {
    id: 'c1',
    name: 'elo-channel',
    sent,
    send: async (data) => {
      if (!data.content && !data.embeds?.length && !data.files?.length) {
        throw new Error('Cannot send an empty message');
      }
      sent.push(data);
      return { id: `m${sent.length}` };
    }
  };
}

function legacyChannel({ failOn = null } = {}) {
  const sent = [];
  return {
    id: 'c1',
    name: 'elo-channel',
    sent,
    send: async (data) => {
      if (!data.content && !data.embed && !data.files?.length) {
        throw new Error('Cannot send an empty message');
      }
      if (failOn !== null && sent.length === failOn) {
        sent.push(null);
        throw new Error('Simulated per-embed failure');
      }
      sent.push(data);
      return { id: `m${sent.length}` };
    }
  };
}

const threeEmbeds = () => [
  { title: 'Round Summary', color: 1 },
  { title: 'Leaderboard', color: 2 },
  { title: 'Matrix', color: 3 }
];

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ── MUST RUN FIRST: before any legacy channel flips the sticky flag ──
await runTest('modern host sends all three embeds in one message', async () => {
  const ch = modernChannel();
  const ok = await EloDiscord.sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, true);
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].embeds.length, 3);
});

await runTest('legacy host delivers every embed, not just the first', async () => {
  const ch = legacyChannel();
  const ok = await EloDiscord.sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, true);
  // The regression this file exists for: this was 1.
  assert.equal(ch.sent.length, 3);
  assert.deepEqual(
    ch.sent.map((d) => d.embed.title),
    ['Round Summary', 'Leaderboard', 'Matrix']
  );
  for (const d of ch.sent) assert.equal(d.embeds, undefined);
});

await runTest('legacy host keeps sending after one embed fails', async () => {
  const ch = legacyChannel({ failOn: 1 });
  const ok = await EloDiscord.sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, false, 'a partial send must not report success');
  const delivered = ch.sent.filter(Boolean).map((d) => d.embed.title);
  assert.deepEqual(delivered, ['Round Summary', 'Matrix']);
});

await runTest('a real failure is reported, not swallowed as legacy', async () => {
  const ch = { id: 'c1', name: 'elo-channel', sent: [], send: async () => { throw new Error('Missing Permissions'); } };
  const ok = await EloDiscord.sendDiscordMessage(ch, { embeds: threeEmbeds() });
  assert.equal(ok, false);
});

await runTest('null channel is refused without throwing', async () => {
  assert.equal(await EloDiscord.sendDiscordMessage(null, { embeds: threeEmbeds() }), false);
});
