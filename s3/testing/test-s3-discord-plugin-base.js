/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       S³ DISCORD PLUGIN BASE TEST                            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Tests S3DiscordPluginBase: sendDiscordMessage() with various
 * message formats, null channel guard, embed wrapping.
 *
 * Uses an inlined S3DiscordPluginBase stub.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node SlackersSquadServices/testing/test-s3-discord-plugin-base.js
 *
 */

import assert from 'node:assert/strict';

class S3DiscordPluginBaseStub {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = options;
    this.connectors = connectors;
    this._s3 = null;
    this._s3db = null;
    this.channel = null;
    this._verboseCalls = [];
  }

  verbose(level, msg) {
    this._verboseCalls.push({ level, msg });
  }

  async sendDiscordMessage(message) {
    if (!this.channel) {
      this.verbose(1, 'Could not send Discord Message. Channel not initialized.');
      return;
    }
    if (typeof message === 'object' && 'embed' in message) {
      message.embed.footer = message.embed.footer || { text: 'Slackers Squad Services' };
      if (typeof message.embed.color === 'string') {
        message.embed.color = parseInt(message.embed.color, 16);
      }
      message = { ...message, embeds: [message.embed] };
    }
    await this.channel.send(message);
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`\u2705 ${name}`);
  } catch (err) {
    console.error(`\u274c ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function main() {
  await runTest('sendDiscordMessage() sends plain string', async () => {
    const plugin = new S3DiscordPluginBaseStub(null, {}, {});
    let sent = null;
    plugin.channel = { send: async (m) => { sent = m; } };
    await plugin.sendDiscordMessage('Hello world');
    assert.equal(sent, 'Hello world');
  });

  await runTest('sendDiscordMessage() wraps embed in embeds array', async () => {
    const plugin = new S3DiscordPluginBaseStub(null, {}, {});
    let sent = null;
    plugin.channel = { send: async (m) => { sent = m; } };
    await plugin.sendDiscordMessage({ embed: { title: 'Test' } });
    assert.ok(Array.isArray(sent.embeds));
    assert.equal(sent.embeds.length, 1);
    assert.equal(sent.embeds[0].title, 'Test');
    assert.deepEqual(sent.embeds[0].footer, { text: 'Slackers Squad Services' });
  });

  await runTest('sendDiscordMessage() preserves existing footer', async () => {
    const plugin = new S3DiscordPluginBaseStub(null, {}, {});
    let sent = null;
    plugin.channel = { send: async (m) => { sent = m; } };
    await plugin.sendDiscordMessage({ embed: { title: 'T', footer: { text: 'Custom' } } });
    assert.equal(sent.embeds[0].footer.text, 'Custom');
  });

  await runTest('sendDiscordMessage() parses hex color strings', async () => {
    const plugin = new S3DiscordPluginBaseStub(null, {}, {});
    let sent = null;
    plugin.channel = { send: async (m) => { sent = m; } };
    await plugin.sendDiscordMessage({ embed: { title: 'T', color: '00FF00' } });
    assert.equal(sent.embeds[0].color, 0x00FF00);
  });

  await runTest('sendDiscordMessage() leaves numeric colors unchanged', async () => {
    const plugin = new S3DiscordPluginBaseStub(null, {}, {});
    let sent = null;
    plugin.channel = { send: async (m) => { sent = m; } };
    await plugin.sendDiscordMessage({ embed: { title: 'T', color: 16711680 } });
    assert.equal(typeof sent.embeds[0].color, 'number');
    assert.equal(sent.embeds[0].color, 16711680);
  });

  await runTest('sendDiscordMessage() returns early when channel is null', async () => {
    const plugin = new S3DiscordPluginBaseStub(null, {}, {});
    plugin.channel = null;
    plugin._verboseCalls = [];
    await plugin.sendDiscordMessage('test');
    assert.ok(plugin._verboseCalls[0].msg.includes('Could not send'));
  });

  await runTest('sendDiscordMessage() passes through already-array embeds', async () => {
    const plugin = new S3DiscordPluginBaseStub(null, {}, {});
    let sent = null;
    plugin.channel = { send: async (m) => { sent = m; } };
    await plugin.sendDiscordMessage({ embeds: [{ title: 'E1' }, { title: 'E2' }] });
    assert.equal(sent.embeds.length, 2);
    assert.equal(sent.embed, undefined);
  });

  await runTest('sendDiscordMessage() preserves extra properties with embed', async () => {
    const plugin = new S3DiscordPluginBaseStub(null, {}, {});
    let sent = null;
    plugin.channel = { send: async (m) => { sent = m; } };
    await plugin.sendDiscordMessage({ content: 'Preview', embed: { title: 'T' } });
    assert.equal(sent.content, 'Preview');
    assert.equal(sent.embeds.length, 1);
  });
}

await main();
if (!process.exitCode) console.log('\nAll s3-discord-plugin-base tests passed.');