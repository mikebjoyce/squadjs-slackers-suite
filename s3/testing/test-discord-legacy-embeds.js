/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       DISCORD LEGACY EMBED FALLBACK TEST                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Covers sendDiscordMessage()'s behaviour on a discord.js too old to
 * accept an `embeds` array.
 *
 * ─── WHAT WENT WRONG ─────────────────────────────────────────────
 *
 * SquadJS 4.1.0 pins discord.js 12.5.3, which has no `embeds` key. An
 * embeds-only payload therefore looks empty to it and the API answers
 * "Cannot send an empty message".
 *
 * The old fallback caught that and retried as `{ embed: embeds[0] }` —
 * the first embed, the rest discarded — then returned `true`. So on
 * every v12 host each multi-embed reply silently lost all but its first
 * embed, and no log line anywhere said so.
 *
 * It surfaced only because two servers answered the same `!s3 players`
 * side by side: the v14 host rendered an overview and both team rosters,
 * the v12 host rendered the overview alone. The harness could not see it,
 * because capturing the payload stubs the sender and the loss happens
 * inside it.
 *
 * ─── WHY THE ORDER OF THESE TESTS MATTERS ────────────────────────
 *
 * `legacyEmbedMode` is module state, sticky for the life of the process
 * once a legacy host is detected — deliberately, so the failed round trip
 * is paid once rather than per message. That makes these tests
 * order-dependent: the modern-host case has to run before anything flips
 * the flag, and it can never be moved below the legacy cases.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-discord-legacy-embeds.js
 *
 */

import assert from 'node:assert/strict';

import { sendDiscordMessage } from '../utils/s3-discord.js';

/** A discord.js v13/v14 channel: understands `embeds`. */
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

/**
 * A discord.js v12 channel: `embeds` is not a key it knows, so a payload
 * carrying only embeds reads as empty — exactly what the real v12 does.
 */
function legacyChannel({ failOn = null } = {}) {
  const sent = [];
  return {
    sent,
    send: async (data) => {
      if (!data.content && !data.embed && !data.files?.length) {
        throw new Error('Cannot send an empty message');
      }
      if (failOn !== null && sent.length === failOn) {
        const err = new Error('Simulated per-embed failure');
        sent.push(null); // still consumed an attempt
        throw err;
      }
      sent.push(data);
      return { id: `m${sent.length}` };
    }
  };
}

const threeEmbeds = () => [
  { title: 'Overview', color: 1 },
  { title: '🟦 Team 1', color: 2 },
  { title: '🟥 Team 2', color: 3 }
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
  const ok = await sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, true, 'send should report success');
  assert.equal(ch.sent.length, 1, 'a modern host takes one message');
  assert.equal(ch.sent[0].embeds.length, 3, 'all three embeds ride together');
  assert.deepEqual(
    ch.sent[0].embeds.map((e) => e.title),
    ['Overview', '🟦 Team 1', '🟥 Team 2']
  );
});

await runTest('legacy host delivers every embed, not just the first', async () => {
  const ch = legacyChannel();
  const ok = await sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, true, 'send should report success');
  // The regression this file exists for: this was 1.
  assert.equal(ch.sent.length, 3, 'one message per embed');
  assert.deepEqual(
    ch.sent.map((d) => d.embed.title),
    ['Overview', '🟦 Team 1', '🟥 Team 2'],
    'every embed arrives, in the order it was built'
  );
  for (const d of ch.sent) {
    assert.equal(d.embeds, undefined, 'the array key is stripped for a v12 host');
  }
});

await runTest('legacy host puts content on the first message only', async () => {
  const ch = legacyChannel();
  const ok = await sendDiscordMessage(ch, { content: 'heads up', embeds: threeEmbeds() });

  assert.equal(ok, true);
  assert.equal(ch.sent.length, 3);
  assert.equal(ch.sent[0].content, 'heads up', 'text pairs with the first embed');
  assert.equal(ch.sent[1].content, undefined, 'and is not repeated');
  assert.equal(ch.sent[2].content, undefined);
});

await runTest('legacy host keeps sending after one embed fails', async () => {
  // Embed 2 of 3 fails. Losing it is no reason to also lose embed 3.
  const ch = legacyChannel({ failOn: 1 });
  const ok = await sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, false, 'a partial send must not report success');
  const delivered = ch.sent.filter(Boolean).map((d) => d.embed.title);
  assert.deepEqual(delivered, ['Overview', '🟥 Team 2'], 'the survivors still went out');
});

await runTest('a single embed still sends on a legacy host', async () => {
  const ch = legacyChannel();
  const ok = await sendDiscordMessage(ch, { embeds: [{ title: 'Status' }] });

  assert.equal(ok, true);
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].embed.title, 'Status');
});

await runTest('singular embed input is normalised and still delivered', async () => {
  const ch = legacyChannel();
  const ok = await sendDiscordMessage(ch, { embed: { title: 'Legacy caller' } });

  assert.equal(ok, true);
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].embed.title, 'Legacy caller');
});

await runTest('a real failure is reported, not swallowed as legacy', async () => {
  const ch = {
    sent: [],
    send: async () => { throw new Error('Missing Permissions'); }
  };
  const ok = await sendDiscordMessage(ch, { embeds: threeEmbeds() });

  assert.equal(ok, false, 'an unrelated error must surface as failure');
});

await runTest('null channel is refused without throwing', async () => {
  assert.equal(await sendDiscordMessage(null, { embeds: threeEmbeds() }), false);
});
