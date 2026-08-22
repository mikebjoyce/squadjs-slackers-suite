import S3PluginBase from './s3-plugin-base.js';

/**
 * TEST/DIAGNOSTIC ONLY — not part of the Slacker's Suite, deliberately
 * absent from install.cjs so `--plugin=all` never sweeps it into a deploy.
 * Install by copying this one file into <squadjs>/squad-server/plugins/
 * (s3-plugin-base.js is already there from the real S3 deploy).
 *
 * On a chat command, sends AdminForceTeamChange for every connected player
 * four times — bare eosID, "EOS:"-prefixed eosID, steamID, then name — and
 * logs the raw RCON response, timing, and each player's teamID before/after
 * every single attempt. This DOES flip real players' teams as a side effect
 * (AdminForceTeamChange only toggles, it can't "set" a team), so only run
 * this when the server is empty except for whoever is testing.
 *
 * Logging is deliberately exhaustive (verbose level 1, always on) so the
 * whole result is visible straight in the SquadJS console/log — no need to
 * come back and add more instrumentation to read a second run.
 *
 * Add to config.json:
 *   { "plugin": "EosIdDiagnostic", "enabled": true }
 * Then in chat: !eosidtest
 */
export default class EosIdDiagnostic extends S3PluginBase {
  static get description() {
    return 'TEST ONLY. Tries AdminForceTeamChange by eosID/steamID/name for every player and logs everything about each attempt.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      enabled: { required: false, description: 'Master switch.', default: false },
      command: { required: false, description: 'Chat command (without !) that runs the test.', default: 'eosidtest' }
    };
  }

  async _onS3Ready() {
    this._handler = () => this.runTest();
    this.server.on(`CHAT_COMMAND:${this.options.command}`, this._handler);
    this.verbose(1, `[EosIDDiag] Ready. Say !${this.options.command} in chat to run it.`);
  }

  async _onUnmount() {
    if (this._handler) this.server.removeListener(`CHAT_COMMAND:${this.options.command}`, this._handler);
  }

  async runTest() {
    const startedAt = new Date().toISOString();
    const players = this.players?.getAllPlayers?.() ?? [];

    this.verbose(1, '='.repeat(70));
    this.verbose(1, `[EosIDDiag] RUN START ${startedAt}`);
    this.verbose(1, `[EosIDDiag] Server: layer=${this.gameState?.getLayerName?.() ?? '?'} gamemode=${this.gameState?.getGamemode?.() ?? '?'}`);
    this.verbose(1, `[EosIDDiag] Players tracked by S3: ${players.length}`);
    this.verbose(1, '[EosIDDiag] WARNING: this WILL flip teams as a side effect of each accepted attempt.');
    this.verbose(1, '='.repeat(70));

    // tally[identifierLabel] = { accepted: n, rejected: n, error: n, na: n }
    const tally = {};
    const bump = (label, key) => {
      tally[label] = tally[label] || { accepted: 0, rejected: 0, error: 0, na: 0 };
      tally[label][key]++;
    };

    for (const p of players) {
      this.verbose(1, '-'.repeat(70));
      this.verbose(1, `[EosIDDiag] PLAYER name="${p.name}" eosID=${p.eosID ?? 'null'} steamID=${p.steamID ?? 'null'} teamID(S3, pre-run)=${p.teamID ?? '?'}`);

      const attempts = [
        { label: 'eosID-bare', value: p.eosID },
        { label: 'eosID-EOS-prefixed', value: p.eosID ? `EOS:${p.eosID}` : null },
        { label: 'steamID', value: p.steamID },
        { label: 'name', value: p.name }
      ];

      for (const { label, value } of attempts) {
        const result = await this.attempt(label, value, p.eosID);
        bump(label, result.tallyKey);
        this.verbose(
          1,
          `[EosIDDiag]   [${label}] value="${value ?? 'n/a'}" cmd=${JSON.stringify(result.command)} ` +
          `verdict=${result.verdict} ms=${result.ms} teamID(before)=${result.teamBefore} teamID(after)=${result.teamAfter} ` +
          `raw=${JSON.stringify(result.response)}`
        );
      }
    }

    this.verbose(1, '='.repeat(70));
    this.verbose(1, '[EosIDDiag] SUMMARY (counts across all players tested):');
    for (const [label, counts] of Object.entries(tally)) {
      this.verbose(
        1,
        `[EosIDDiag]   ${label}: accepted=${counts.accepted} rejected=${counts.rejected} ` +
        `error=${counts.error} n/a=${counts.na}`
      );
    }
    this.verbose(1, `[EosIDDiag] RUN END ${new Date().toISOString()} (started ${startedAt})`);
    this.verbose(1, '='.repeat(70));
  }

  /**
   * Sends one AdminForceTeamChange attempt and captures everything about
   * it: the exact command string, the raw response, elapsed time, and the
   * player's teamID immediately before and after (via a forced S3 refresh,
   * so "after" reflects the real server state, not a stale cache).
   */
  async attempt(label, value, eosIDForLookup) {
    const before = this.players?.getPlayer?.(eosIDForLookup);
    const teamBefore = before?.teamID ?? '?';

    if (!value) {
      return { command: null, response: null, ms: 0, verdict: 'N/A', tallyKey: 'na', teamBefore, teamAfter: teamBefore };
    }

    const command = `AdminForceTeamChange "${value}"`;
    const start = Date.now();
    let response = null;
    let verdict;
    let tallyKey;

    try {
      response = await this.server.rcon.execute(command);
      const rejected = typeof response === 'string' && /unable to find player/i.test(response);
      verdict = rejected ? 'REJECTED' : 'ACCEPTED';
      tallyKey = rejected ? 'rejected' : 'accepted';
    } catch (err) {
      response = err.message;
      verdict = 'ERROR';
      tallyKey = 'error';
    }

    const ms = Date.now() - start;

    if (this.players?.refreshNow) {
      await this.players.refreshNow('eosid-diagnostic').catch(() => {});
    }
    const after = this.players?.getPlayer?.(eosIDForLookup);
    const teamAfter = after?.teamID ?? '?';

    return { command, response, ms, verdict, tallyKey, teamBefore, teamAfter };
  }
}
