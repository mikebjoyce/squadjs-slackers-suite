/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       S³ PLUGIN BASE LIFECYCLE TEST                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Tests S3PluginBase lifecycle: _resolveS3(), _awaitS3Ready(),
 * prepareToMount() / mount() / unmount() call order, service
 * accessor null guards, and _onS3Ready()/_onUnmount() hooks.
 *
 * Uses an inlined mock base class (S3PluginBaseStub) that mirrors
 * the real S3PluginBase logic without importing SquadJS core.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node SlackersSquadServices/testing/test-s3-plugin-base-lifecycle.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Does NOT require a running SquadJS server.
 * - The stub reproduces all public methods of S3PluginBase.
 *
 */

import assert from 'node:assert/strict';

// ── S3PluginBase stub (mirrors plugins/s3-plugin-base.js) ────────

class S3PluginBaseStub {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = options;
    this.connectors = connectors;
    this._s3 = null;
    this._s3db = null;
    this._verboseCalls = [];
  }

  verbose(level, msg) {
    this._verboseCalls.push({ level, msg });
  }

  // ── S³ Discovery ─────────────────────────────────────────

  _resolveS3() {
    if (!this.server.plugins) {
      throw new Error(
        '[S3] server.plugins not available. Cannot discover SlackersSquadServices.'
      );
    }
    const s3 = this.server.plugins.find(
      (p) => p.constructor.name === 'SlackersSquadServices'
    );
    if (!s3) {
      throw new Error(
        '[S3] SlackersSquadServices is required for this plugin. ' +
        'Ensure it is in config.json before this plugin and restart.'
      );
    }
    this._s3 = s3;
    return s3;
  }

  async _awaitS3Ready(timeoutMs = 30000) {
    if (!this._s3) {
      throw new Error(
        '[S3] S³ not discovered. Call _resolveS3() or ensure prepareToMount() ran.'
      );
    }

    if (typeof this._s3.isReady === 'function' && this._s3.isReady()) {
      return true;
    }

    if (typeof this._s3.ready === 'function') {
      try {
        await this._s3.ready();
        return true;
      } catch (err) {
        this.verbose(1, `[S3] ready() promise rejected: ${err.message}`);
      }
    }

    const pollInterval = 100;
    const maxAttempts = Math.ceil(timeoutMs / pollInterval);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (typeof this._s3.isReady === 'function' && this._s3.isReady()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(
      `[S3] S³ not ready after ${timeoutMs}ms timeout. ` +
      'Check that SlackersSquadServices is mounted and not crashing.'
    );
  }

  // ── Lifecycle ────────────────────────────────────────────

  async prepareToMount() {
    this._resolveS3();
  }

  async mount() {
    if (this._s3) {
      await this._s3.ready();
      this._s3db = this._s3.db || null;
    }
    await this._onS3Ready();
  }

  async unmount() {
    await this._onUnmount();
    this._s3db = null;
  }

  async _onS3Ready() {}

  async _onUnmount() {}

  // ── Database Convenience ─────────────────────────────────

  defineModel(name, schema, opts = {}) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    return this._s3db.defineModel(name, schema, opts);
  }

  registerExpectedVersion(pluginName, version) {
    if (!this._s3db || typeof this._s3db.registerExpectedVersion !== 'function') {
      return;
    }
    this._s3db.registerExpectedVersion(pluginName, version);
  }

  registerMigrations(pluginName, migrations) {
    if (!this._s3db || !this._s3db.migrationEngine) {
      return;
    }
    this._s3db.migrationEngine.registerMigrations(pluginName, migrations);
  }

  async verifyAndRunMigrations(pluginName) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    const recheck = await this._s3db.verifySchemaVersions();
    if (!recheck.upToDate) {
      const result = await this._s3db.migrationEngine.runMigrations(pluginName);
      return result;
    }
    return null;
  }

  _getModel(name) {
    return this._s3db?.models?.[name] || null;
  }

  async _withDb(fn) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    try {
      return await this._s3db.withTransactionWithRetry(fn);
    } catch (err) {
      this.verbose(1, `[DB] Error in _withDb: ${err.message}`);
      return null;
    }
  }

  // ── Service Accessors ────────────────────────────────────

  get s3() { return this._s3; }
  get s3db() { return this._s3db; }
  get gameState() { return this._s3?.gameState || null; }
  get players() { return this._s3?.players || null; }
  get clans() { return this._s3?.clans || null; }
  get factions() { return this._s3?.factions || null; }
  get serverConfig() { return this._s3?.serverConfig || null; }
}

// ── Mock factories ──────────────────────────────────────────────

const makeMockRcon = () => ({
  switchTeam: async () => {},
  warn: async () => {}
});

const makeMockS3 = (isReadyValue = true) => {
  const s3 = {
    constructor: { name: 'SlackersSquadServices' },
    _ready: Promise.resolve(),
    _isReady: isReadyValue,
    isReady() { return this._isReady; },
    ready() { return this._ready; },
    db: null,
    gameState: { currentPhase: 'in-play' },
    players: { count: 10 },
    clans: { tagMap: new Map() },
    factions: { activeFactions: ['usa', 'rus'] },
    serverConfig: { raw: {} }
  };
  return s3;
};

const makeMockServer = (pluginsArray) => ({
  plugins: pluginsArray || [],
  rcon: makeMockRcon()
});

// ── Test harness ─────────────────────────────────────────────────

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

// ── Tests ────────────────────────────────────────────────────────

async function main() {

  // ──────────────────────────────────────
  // 1. _resolveS3() — finds S³ by constructor name
  // ──────────────────────────────────────
  await runTest('_resolveS3() discovers S³ plugin by constructor name', () => {
    const s3 = makeMockS3();
    const server = makeMockServer([
      { constructor: { name: 'SomeOtherPlugin' } },
      s3
    ]);
    const plugin = new S3PluginBaseStub(server, {}, {});

    const result = plugin._resolveS3();
    assert.equal(result, s3);
    assert.equal(plugin._s3, s3);
  });

  // ──────────────────────────────────────
  // 2. _resolveS3() — throws if S³ not found
  // ──────────────────────────────────────
  await runTest('_resolveS3() throws if S³ not in server.plugins', () => {
    const server = makeMockServer([
      { constructor: { name: 'SomethingElse' } }
    ]);
    const plugin = new S3PluginBaseStub(server, {}, {});

    assert.throws(() => plugin._resolveS3(), /SlackersSquadServices is required/);
    assert.equal(plugin._s3, null);
  });

  // ──────────────────────────────────────
  // 3. _resolveS3() — throws if no server.plugins
  // ──────────────────────────────────────
  await runTest('_resolveS3() throws if server.plugins is absent', () => {
    const server = {};
    const plugin = new S3PluginBaseStub(server, {}, {});

    assert.throws(() => plugin._resolveS3(), /server\.plugins not available/);
  });

  // ──────────────────────────────────────
  // 4. _awaitS3Ready() — fast path when already ready
  // ──────────────────────────────────────
  await runTest('_awaitS3Ready() returns true when isReady() returns true', async () => {
    const s3 = makeMockS3(true);
    const server = makeMockServer([s3]);
    const plugin = new S3PluginBaseStub(server, {}, {});
    plugin._resolveS3();

    const result = await plugin._awaitS3Ready(1000);
    assert.equal(result, true);
  });

  // ──────────────────────────────────────
  // 5. _awaitS3Ready() — awaits deferred ready() promise
  // ──────────────────────────────────────
  await runTest('_awaitS3Ready() awaits the deferred ready() promise', async () => {
    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    const s3 = makeMockS3(false);
    s3._ready = readyPromise;
    s3.ready = () => readyPromise;
    s3.isReady = () => false;

    const server = makeMockServer([s3]);
    const plugin = new S3PluginBaseStub(server, {}, {});
    plugin._resolveS3();

    const waitPromise = plugin._awaitS3Ready(5000);

    await new Promise((r) => setTimeout(r, 10));
    resolveReady();

    const result = await waitPromise;
    assert.equal(result, true);
  });

  // ──────────────────────────────────────
  // 6. _awaitS3Ready() — throws on timeout
  // ──────────────────────────────────────
  await runTest('_awaitS3Ready() throws when S³ not ready within timeout', async () => {
    const s3 = {
      constructor: { name: 'SlackersSquadServices' },
      _isReady: false,
      isReady() { return this._isReady; }
    };
    const server = makeMockServer([s3]);
    const plugin = new S3PluginBaseStub(server, {}, {});
    plugin._resolveS3();

    await assert.rejects(
      () => plugin._awaitS3Ready(50),
      /S³ not ready after/
    );
  });

  // ──────────────────────────────────────
  // 7. _awaitS3Ready() — throws if _s3 is null
  // ──────────────────────────────────────
  await runTest('_awaitS3Ready() throws when _s3 is null', async () => {
    const plugin = new S3PluginBaseStub(makeMockServer([]), {}, {});

    await assert.rejects(
      () => plugin._awaitS3Ready(100),
      /S³ not discovered/
    );
  });

  // ──────────────────────────────────────
  // 8. Lifecycle call order: prepareToMount → mount → unmount
  // ──────────────────────────────────────
  await runTest('prepareToMount → mount → unmount calls hooks in correct order', async () => {
    const s3 = makeMockS3(true);
    const server = makeMockServer([s3]);
    const plugin = new S3PluginBaseStub(server, {}, {});
    const order = [];

    // Override hooks to track order
    plugin._onS3Ready = async () => order.push('_onS3Ready');
    plugin._onUnmount = async () => order.push('_onUnmount');

    // Track lifecycle methods
    const origPrepare = plugin.prepareToMount.bind(plugin);
    plugin.prepareToMount = async () => {
      await origPrepare();
      order.push('prepareToMount');
    };
    const origMount = plugin.mount.bind(plugin);
    plugin.mount = async () => {
      await origMount();
      order.push('mount');
    };
    const origUnmount = plugin.unmount.bind(plugin);
    plugin.unmount = async () => {
      await origUnmount();
      order.push('unmount');
    };

    await plugin.prepareToMount();
    await plugin.mount();
    await plugin.unmount();

    assert.deepEqual(order, ['prepareToMount', '_onS3Ready', 'mount', '_onUnmount', 'unmount']);
  });

  // ──────────────────────────────────────
  // 9. Service accessors return null before discovery
  // ──────────────────────────────────────
  await runTest('Service accessors return null before _resolveS3()', () => {
    const plugin = new S3PluginBaseStub(makeMockServer([]), {}, {});

    assert.equal(plugin.s3, null);
    assert.equal(plugin.s3db, null);
    assert.equal(plugin.gameState, null);
    assert.equal(plugin.players, null);
    assert.equal(plugin.clans, null);
    assert.equal(plugin.factions, null);
    assert.equal(plugin.serverConfig, null);
  });

  // ──────────────────────────────────────
  // 10. Service accessors return values after discovery
  // ──────────────────────────────────────
  await runTest('Service accessors return values after S³ discovered', () => {
    const s3 = makeMockS3(true);
    const server = makeMockServer([s3]);
    const plugin = new S3PluginBaseStub(server, {}, {});
    plugin._resolveS3();

    assert.equal(plugin.s3, s3);
    assert.equal(plugin.s3db, null);
    assert.equal(plugin.gameState, s3.gameState);
    assert.equal(plugin.players, s3.players);
    assert.equal(plugin.clans, s3.clans);
    assert.equal(plugin.factions, s3.factions);
    assert.equal(plugin.serverConfig, s3.serverConfig);
  });

  // ──────────────────────────────────────
  // 11. _onS3Ready() and _onUnmount() are no-ops by default
  // ──────────────────────────────────────
  await runTest('Default _onS3Ready() and _onUnmount() hooks do not throw', async () => {
    const s3 = makeMockS3(true);
    const server = makeMockServer([s3]);
    const plugin = new S3PluginBaseStub(server, {}, {});
    plugin._resolveS3();

    await plugin._onS3Ready();
    await plugin._onUnmount();
  });

  // ──────────────────────────────────────
  // 12. s3db is set after mount if DB is available
  // ──────────────────────────────────────
  await runTest('s3db is cached after mount when DB is available', async () => {
    const mockDb = { isReady: () => true, models: {} };
    const s3 = makeMockS3(true);
    s3.db = mockDb;
    const server = makeMockServer([s3]);
    const plugin = new S3PluginBaseStub(server, {}, {});
    plugin._resolveS3();

    await plugin.mount();
    assert.equal(plugin._s3db, mockDb);
    assert.equal(plugin.s3db, mockDb);
  });

  // ──────────────────────────────────────
  // 13. s3db stays null after mount if no DB
  // ──────────────────────────────────────
  await runTest('s3db stays null after mount when no DB on S³', async () => {
    const s3 = makeMockS3(true);
    s3.db = null;
    const server = makeMockServer([s3]);
    const plugin = new S3PluginBaseStub(server, {}, {});
    plugin._resolveS3();

    await plugin.mount();
    assert.equal(plugin._s3db, null);
    assert.equal(plugin.s3db, null);
  });

  // ──────────────────────────────────────
  // 14. unmount() clears _s3db
  // ──────────────────────────────────────
  await runTest('unmount() clears _s3db', async () => {
    const mockDb = { isReady: () => true, models: {} };
    const s3 = makeMockS3(true);
    s3.db = mockDb;
    const server = makeMockServer([s3]);
    const plugin = new S3PluginBaseStub(server, {}, {});
    plugin._resolveS3();

    await plugin.mount();
    assert.equal(plugin._s3db, mockDb);

    await plugin.unmount();
    assert.equal(plugin._s3db, null);
  });
}

await main();

if (!process.exitCode) {
  console.log('\nAll s3-plugin-base lifecycle tests passed.');
}