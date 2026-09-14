/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       TB DISCORD LEGACY EMBED FALLBACK TEST                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Covers DiscordHelpers.sendDiscordMessage()'s behaviour on a discord.js
 * too old to accept an `embeds` array — the same regression fixed in
 * s3/testing/test-discord-legacy-embeds.js, duplicated here because
 * TeamBalancer keeps its own copy of the sender (Pattern B, manual
 * Discord management) rather than importing S³'s.
 *
 * The scramble report at tb-commands.js:458 is the multi-embed payload
 * this plugin sends; on a discord.js v12 host it used to arrive as its
 * first embed only, with no error anywhere.
 *
 * ─── ORDER MATTERS ────────────────────────────────────────────────
 *
 * legacyEmbedMode is module state, sticky once a legacy host is detected.
 * The modern-host case has to run first.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node team-balancer/testing/test-tb-discord-legacy-embeds.js
 *
 */

import assert from 'node:assert/strict';

import { DiscordHelpers } from '../utils/tb-discord-helpers.js';

function modernChannel() {
  const sent = [];
  return {
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
  { title: 'Scramble Report', color: 1 },
  { title: 'Team 1', color: 2 },
  { title: 'Team 2', color: 3 }
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
  const ok = await DiscordHelpers.sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, true);
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].embeds.length, 3);
});

await runTest('legacy host delivers every embed, not just the first', async () => {
  const ch = legacyChannel();
  const ok = await DiscordHelpers.sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, true);
  // The regression this file exists for: this was 1.
  assert.equal(ch.sent.length, 3);
  assert.deepEqual(
    ch.sent.map((d) => d.embed.title),
    ['Scramble Report', 'Team 1', 'Team 2']
  );
  for (const d of ch.sent) assert.equal(d.embeds, undefined);
});

await runTest('legacy host keeps sending after one embed fails', async () => {
  const ch = legacyChannel({ failOn: 1 });
  const ok = await DiscordHelpers.sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, false, 'a partial send must not report success');
  const delivered = ch.sent.filter(Boolean).map((d) => d.embed.title);
  assert.deepEqual(delivered, ['Scramble Report', 'Team 2']);
});

await runTest('a real failure is reported, not swallowed as legacy', async () => {
  const ch = { sent: [], send: async () => { throw new Error('Missing Permissions'); } };
  const ok = await DiscordHelpers.sendDiscordMessage(ch, { embeds: threeEmbeds() });
  assert.equal(ok, false);
});

await runTest('null channel is refused without throwing', async () => {
  assert.equal(await DiscordHelpers.sendDiscordMessage(null, { embeds: threeEmbeds() }), false);
});
