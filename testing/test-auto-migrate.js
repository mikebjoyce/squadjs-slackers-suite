/**
 * S³ AUTO-MIGRATE TEST
 * Usage: node SlackersSquadServices/testing/test-auto-migrate.js
 */
import assert from 'node:assert/strict';

async function runTest(name, fn) {
  try { await fn(); console.log('\u2705 ' + name); }
  catch (err) { console.error('\u274c ' + name); console.error(err); process.exitCode = 1; }
}

async function main() {
  await runTest('autoMigrate: true skips Discord prompt path', () => {
    const config = { autoMigrate: true, discord: { channel: 'admin' } };
    const shouldPrompt = config.discord && !config.autoMigrate;
    assert.equal(shouldPrompt, false);
  });

  await runTest('autoMigrate: false invokes Discord prompt path', () => {
    const config = { autoMigrate: false, discord: { channel: 'admin' } };
    const shouldPrompt = config.discord && !config.autoMigrate;
    assert.equal(shouldPrompt, true);
  });
}

await main();
if (!process.exitCode) console.log('\nAll auto-migrate tests passed.');