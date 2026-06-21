import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import ServerConfigService from '../utils/server-config-service.js';

// Test directory setup
const TEST_DIR = join(process.cwd(), 'test-config-tmp');
const SERVER_CFG_PATH = join(TEST_DIR, 'Server.cfg');
const VOTE_CFG_PATH = join(TEST_DIR, 'VoteConfig.cfg');

function setup() {
  // Create temp directory and config files
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  // Remove temp directory
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function createConfigFiles(serverContent, voteContent) {
  writeFileSync(SERVER_CFG_PATH, serverContent, 'utf8');
  writeFileSync(VOTE_CFG_PATH, voteContent, 'utf8');
}

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

// Run tests
setup();

await runTest('returns defaults when config files do not exist', async () => {
  teardown(); // Ensure clean state

  const service = new ServerConfigService({
    configPath: join(TEST_DIR, 'nonexistent')
  });

  await service.mount();

  assert.equal(service.isLoadedSuccessfully(), false);
  assert.equal(service.getMaxPlayers(), 100);
  assert.equal(service.getNumReservedSlots(), 2);
  assert.equal(service.getAllowTeamChanges(), false);
  assert.equal(service.getTimeBetweenMatches(), 60);
  assert.equal(service.getTimeBeforeVote(), 30);
  assert.equal(service.getTeamVoteDuration(), 25);
  assert.equal(service.getLayerVoteDuration(), 25);

  await service.unmount();
});

await runTest('parses Server.cfg values correctly', async () => {
  setup();

  const serverContent = `
// Server config
MaxPlayers=80
NumReservedSlots=4
AllowTeamChanges=true
TimeBetweenMatches=90
TimeBeforeVote=45
`;
  createConfigFiles(serverContent, '');

  const service = new ServerConfigService({ configPath: TEST_DIR });
  await service.mount();

  assert.equal(service.isLoadedSuccessfully(), true);
  assert.equal(service.getMaxPlayers(), 80);
  assert.equal(service.getNumReservedSlots(), 4);
  assert.equal(service.getAllowTeamChanges(), true);
  assert.equal(service.getTimeBetweenMatches(), 90);
  assert.equal(service.getTimeBeforeVote(), 45);

  await service.unmount();
  teardown();
});

await runTest('parses VoteConfig.cfg values correctly', async () => {
  setup();

  const voteContent = `
// Voting config
LayerVoteDuration=30
TeamVote_Duration=30
`;
  createConfigFiles('', voteContent);

  const service = new ServerConfigService({ configPath: TEST_DIR });
  await service.mount();

  assert.equal(service.isLoadedSuccessfully(), true);
  assert.equal(service.getTeamVoteDuration(), 30);
  assert.equal(service.getLayerVoteDuration(), 30);
  // Should still have defaults for Server.cfg values
  assert.equal(service.getMaxPlayers(), 100);

  await service.unmount();
  teardown();
});

await runTest('parses both config files and merges values', async () => {
  setup();

  const serverContent = `
MaxPlayers=50
AllowTeamChanges=true
`;
  const voteContent = `
TeamVote_Duration=35
`;
  createConfigFiles(serverContent, voteContent);

  const service = new ServerConfigService({ configPath: TEST_DIR });
  await service.mount();

  assert.equal(service.isLoadedSuccessfully(), true);
  assert.equal(service.getMaxPlayers(), 50);
  assert.equal(service.getAllowTeamChanges(), true);
  assert.equal(service.getTeamVoteDuration(), 35);
  // Defaults from other values
  assert.equal(service.getNumReservedSlots(), 2);
  assert.equal(service.getLayerVoteDuration(), 25);

  await service.unmount();
  teardown();
});

await runTest('handles quoted values in Server.cfg', async () => {
  setup();

  const serverContent = `ServerName="Northern Lights Server"
MaxPlayers=100
`;
  createConfigFiles(serverContent, '');

  const service = new ServerConfigService({ configPath: TEST_DIR });
  await service.mount();

  // MaxPlayers should still parse correctly despite quoted ServerName
  assert.equal(service.getMaxPlayers(), 100);

  await service.unmount();
  teardown();
});

await runTest('getConfig returns all values in a flat object', async () => {
  setup();

  const serverContent = `MaxPlayers=64
AllowTeamChanges=true
`;
  createConfigFiles(serverContent, '');

  const service = new ServerConfigService({ configPath: TEST_DIR });
  await service.mount();

  const config = service.getConfig();
  assert.equal(config.MaxPlayers, 64);
  assert.equal(config.AllowTeamChanges, true);
  assert.equal(config.NumReservedSlots, 2); // default
  assert.equal(config.TimeBetweenMatches, 60); // default

  await service.unmount();
  teardown();
});

await runTest('mount/unmount does not bind server listeners', async () => {
  const service = new ServerConfigService({ configPath: TEST_DIR });
  await service.mount();
  // ServerConfigService should not interact with server directly
  // No server listeners are needed
  await service.unmount();
});

if (!process.exitCode) {
  console.log('\nAll server-config-service tests passed.');
}

// Cleanup
teardown();