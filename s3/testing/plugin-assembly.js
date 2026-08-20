/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   PLUGIN ASSEMBLY — import consumer plugins as they ship      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Consumer plugin entry points import sibling S³ files
 * (`./s3-plugin-base.js`, `./s3-discord-plugin-base.js`), which only resolve
 * in the FLATTENED layout install.cjs produces — in this source tree those
 * files live under s3/plugins/. So a test that needs a real plugin class,
 * rather than a stand-in, has to build the shipped layout first.
 *
 * Doing that has the additional virtue of proving the shipped layout imports
 * cleanly, which no other test asserts.
 *
 * The assembly is built inside the repo (not the OS temp dir) so that bare
 * imports like 'sequelize' still resolve up the directory tree to the SquadJS
 * node_modules, and so `../../core/logger.js` finds the repo's test shim.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   const dir = buildAssembly('.tmp-myfeature');
 *   const Switch = await importFromAssembly(dir, 'switch.js');
 *   // ... tests ...
 *   cleanAssembly(dir);
 *
 * Give each caller its own directory name so two suites running at once do
 * not delete each other's assembly mid-import.
 */

'use strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Build a throwaway flattened assembly via the real install.cjs.
 *
 * @param {string} dirName - Repo-relative directory name, e.g. '.tmp-conformance'
 * @returns {string} absolute path to the assembly
 */
export function buildAssembly(dirName) {
  const assemblyDir = path.join(REPO_ROOT, dirName);
  fs.rmSync(assemblyDir, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, 'install.cjs'), '--plugin=all', `--output=${assemblyDir}`, '--force'],
    { cwd: REPO_ROOT, stdio: 'pipe' }
  );

  // SquadJS's own BasePlugin lives in a deployed SquadJS install, not in this
  // repo — the same reason core/logger.js is a shim here. Drop a stand-in into
  // the assembly (never into the source tree, where install.cjs would ship it
  // and collide with the real one).
  //
  // The constructor is a faithful copy of SquadJS 4.1.0's
  // squad-server/plugins/base-plugin.js, minus its `core/logger` import. That
  // matters: it is where option defaults are applied from optionsSpecification,
  // where `connector: true` options are swapped for the connector instance, and
  // where `required` options are enforced. A stub that merely assigned
  // `this.options = options` would leave every unset option undefined, so a
  // test could pass while production — which fills the default in — took a
  // different branch entirely.
  fs.writeFileSync(
    path.join(assemblyDir, 'plugins', 'base-plugin.js'),
    `// Test shim — see s3/testing/plugin-assembly.js.
// Mirrors SquadJS 4.1.0 squad-server/plugins/base-plugin.js.
export default class BasePlugin {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = {};
    this.rawOptions = options;
    this.connectors = connectors;
    this.logs = [];

    for (const [optionName, option] of Object.entries(this.constructor.optionsSpecification)) {
      if (option.connector) {
        this.options[optionName] = (connectors || {})[this.rawOptions[optionName]];
      } else {
        if (option.required) {
          if (!(optionName in this.rawOptions))
            throw new Error(\`\${this.constructor.name}: \${optionName} is required but missing.\`);
          if (option.default === this.rawOptions[optionName])
            throw new Error(
              \`\${this.constructor.name}: \${optionName} is required but is the default value.\`
            );
        }

        this.options[optionName] =
          typeof this.rawOptions[optionName] !== 'undefined'
            ? this.rawOptions[optionName]
            : option.default;
      }
    }
  }

  async prepareToMount() {}
  async mount() {}
  async unmount() {}

  static get description() { return ''; }
  static get defaultEnabled() { return true; }
  static get optionsSpecification() { return {}; }

  // The real one delegates to core/logger. Capturing instead lets a test
  // assert on what a plugin reported without a live Logger.
  verbose(...args) { this.logs.push(args); }
}
`
  );

  return assemblyDir;
}

/**
 * Import a plugin's default export from a built assembly.
 *
 * @param {string} assemblyDir - Absolute path returned by buildAssembly()
 * @param {string} fileName - Entry point file, e.g. 'switch.js'
 * @returns {Promise<Function>} the plugin class
 */
export async function importFromAssembly(assemblyDir, fileName) {
  const target = path.join(assemblyDir, 'plugins', fileName);
  const module = await import(pathToFileURL(target).href);
  return module.default;
}

/** Remove an assembly. Safe to call when it was never built. */
export function cleanAssembly(assemblyDir) {
  fs.rmSync(assemblyDir, { recursive: true, force: true });
}
