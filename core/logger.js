// Shim for running tests outside a SquadJS install (this source monorepo has no live SquadJS).
// The real Logger lives at squad-server/logic/core/logger.js in a deployed SquadJS environment.
// This shim is excluded from git (core/ is gitignored) and from install.cjs assembly.
export default { verbose() {} };