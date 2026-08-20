// Shim for running tests outside a SquadJS install (this source monorepo has no live SquadJS).
// The real Logger lives at squad-server/logic/core/logger.js in a deployed SquadJS environment.
// This file IS tracked in git — the previous claim that "core/ is gitignored" was
// wrong, and it has to be tracked, or a clean checkout could not run any test that
// imports it. It is excluded from the install.cjs assembly, which only copies the
// five plugin directories, so it can never overwrite a real SquadJS Logger.
export default { verbose() {} };