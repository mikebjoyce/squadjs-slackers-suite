// Shim for running tests outside a SquadJS install.
// The original import path ../../squadjs-elo-tracker/tools/elo-clan-grouping.js referenced
// the frozen SlackersSquadServices repo. This shim delegates to S³'s ClansService which
// provides the canonical extractClanGroups implementation in this monorepo.
import ClansService from '../../s3/utils/clans-service.js';

// Create a throwaway instance with no-ops for the things ClansService needs in production.
const clansService = new ClansService({ verbose: () => {} });

// Wrap the instance method as the standalone function the test runner expects.
export function extractClanGroups(players, options = {}) {
  return clansService.extractClanGroups(players, options);
}