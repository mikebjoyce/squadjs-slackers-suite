/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                         ELO COMMANDS                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Registers in-game chat command handlers onto the EloTracker plugin
 * instance. Provides a public !elo command and an admin-restricted
 * !eloadmin command for in-game use.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloCommands (default)
 *   Object with a single register(tracker) method. Mutates the
 *   tracker instance by attaching three methods directly onto it:
 *     respond(player, msg)       — rcon.warn wrapper with logging.
 *     onEloCommand(info)         — Handles !elo chat commands.
 *     onEloAdminCommand(info)    — Handles !eloadmin chat commands.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Logger (../../core/logger.js)
 *   Verbose logging for command responses, lookup failures, and
 *   rcon.warn errors.
 * EloDatabase (./elo-database.js)
 *   Static formatOtherMatches() for the ambiguous-lookup hint line.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Methods are attached directly onto the tracker instance, not
 *   returned as standalone functions. They rely on tracker.server,
 *   tracker.db, tracker.session, tracker.eloCache, and tracker.options.
 * - onEloAdminCommand enforces ChatAdmin channel restriction internally.
 *   The caller must still register the event listener.
 * - !eloadmin reset resets mu, sigma, wins, losses, and roundsPlayed
 *   to defaults. It does NOT delete the DB record. It acts only on an
 *   unambiguous match (EloDatabase.isUnambiguous): a good tier AND no
 *   equally-good rival. Anything less lists the candidates and resets
 *   nothing.
 * - !elo with no sub-command shows the caller's own rating.
 * - !elo <name|steamID> looks up another player. The name search is
 *   ranked (see searchPlayers() in elo-database.js) and appends an
 *   "Also matched" line whenever the term was not an exact hit.
 * - Sub-commands are matched case-insensitively; SquadJS lowercases the
 *   command word itself before emitting CHAT_COMMAND:*, so `!ELO` works.
 * - Unknown sub-commands show help text.
 *
 *   Calculates and displays a "Competitive Skill Rank" (CSR) (μ - 3.0σ)
 *   as the primary player rank to encourage active play.
 *
 *
 * ─── AUTHOR ──────────────────────────────────────────────────────
 *
 * Slacker
 * Discord: real_slacker
 * GitHub:  https://github.com/mikebjoyce/squadjs-elo-tracker
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';
import EloCalculator from './elo-calculator.js';
import EloDatabase from './elo-database.js';

const EloCommands = {
  register(tracker) {

    // Shared respond helper — wraps rcon.warn with logging
    tracker.respond = async function(player, msg) {
      const name = player?.name || 'Unknown';
      const ident = player?.name || player?.eosID || player?.steamID;
      Logger.verbose('EloTracker', 2, `[Response to ${name}]\n${msg}`);
      if (ident) {
        try {
          await this.server.rcon.warn(ident, msg);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] rcon.warn failed for ${ident}: ${err.message}`);
        }
      }
      return msg;
    };

    // ─── Helper — shared lookup logic ─────────────────────────────────
    async function _lookupAndRespond(trackerCtx, player, identifier) {
      // Ranked candidates rather than a single row: the best match is what we
      // display, and the rest become the "Also matched" hint below so a player
      // whose partial name was ambiguous can see what else it could have been.
      const candidates = await trackerCtx._findPlayerCandidates(identifier);
      const record = candidates.length ? candidates[0] : null;
      if (!record) {
        return await trackerCtx.respond(player, [
          tracker.localize('eloTracker.lookupAndRespond.noEloRecordFound', { identifier }),
          tracker.localize('eloTracker.lookupAndRespond.typeEloHelpFor')
        ].join('\n'));
      }

      const minRounds = trackerCtx.options.minRoundsForLeaderboard;
      let rankLine;
      const consRating = record.mu - (EloCalculator.SIGMA_MULTIPLIER * record.sigma);
      if (record.roundsPlayed < minRounds) {
        rankLine = `Rank: Provisional (${record.roundsPlayed}/${minRounds} rounds)`;
      } else {
        const rank = await trackerCtx.db.getPlayerRank(record.eosID, minRounds);
        const total = await trackerCtx.db.getTotalPlayers();
        rankLine = `Rank: #${rank} (of ${total} total)`;
      }

      // null whenever the match was exact — see EloDatabase.formatOtherMatches().
      const otherMatches = EloDatabase.formatOtherMatches(candidates);

      return await trackerCtx.respond(player, [
        `=== ${record.name} ===`,
        rankLine,
        tracker.localize('eloTracker.lookupAndRespond.csr', { consRating: consRating.toFixed(2) }),
        tracker.localize('eloTracker.lookupAndRespond.estimatedSkillRecordCertainty', { record: record.mu.toFixed(2), record2: record.sigma.toFixed(2) }),
        tracker.localize('eloTracker.lookupAndRespond.recordWinsWLosses', { wins: record.wins, losses: record.losses, roundsPlayed: record.roundsPlayed }),
        otherMatches
      ].filter(Boolean).join('\n'));
    }

    // Public in-game command handler
    // Registered on CHAT_COMMAND:elo
    // Available to all players in any chat channel
    tracker.onEloCommand = async function(info) {
      if (!this.ready) return;
      if (this.options.enablePublicIngameCommands === false) return;

      const args = (info.message || '')
        .replace(/^!elo\s*/i, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = args[0]?.toLowerCase();
      const player = info.player || { steamID: info.steamID, name: info.playerName };

      // !elo help
      if (sub === 'help') {
        return await this.respond(player, [
          tracker.localize('eloTracker.onEloCommand.elotrackerCommands'),
          tracker.localize('eloTracker.onEloCommand.eloShowYourCurrent'),
          tracker.localize('eloTracker.onEloCommand.eloNameSteamidLook'),
          tracker.localize('eloTracker.onEloCommand.eloLeaderboardTopPlayers'),
          tracker.localize('eloTracker.onEloCommand.eloHelpShowThis')
        ].join('\n'));
      }

      // !elo leaderboard
      if (sub === 'leaderboard') {
        try {
          const players = await this.db.getLeaderboard(10, this.options.minRoundsForLeaderboard);
          if (!players.length) {
            return await this.respond(player, tracker.localize('eloTracker.onEloCommand.noLeaderboardDataYet'));
          }
          const lines = players.map((p, i) => {
            const consRating = p.mu - (EloCalculator.SIGMA_MULTIPLIER * p.sigma);
            return `#${(i + 1).toString().padStart(2, ' ')} ${p.name.trim()}: ${consRating.toFixed(1)} ${p.wins}W/${p.losses}L`;
          });
          return await this.respond(player, [tracker.localize('eloTracker.onEloCommand.eloLeaderboard'), ...lines].join('\n'));
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] Leaderboard failed: ${err.message}`);
          return await this.respond(player, tracker.localize('eloTracker.onEloCommand.failedToRetrieveLeaderboard'));
        }
      }

      // !elo (no args) — self lookup
      if (!sub) {
        const identifier = player.steamID || player.eosID;
        try {
          return await _lookupAndRespond(this, player, identifier);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] Player lookup failed: ${err.message}`);
          return await this.respond(player, tracker.localize('eloTracker.onEloCommand.failedToRetrievePlayer'));
        }
      }

      // !elo <identifier> — lookup another player by name/steamID
      const identifier = args.join(' ');
      try {
        return await _lookupAndRespond(this, player, identifier);
      } catch (err) {
        Logger.verbose('EloTracker', 1, `[EloCommands] Player lookup failed: ${err.message}`);
        return await this.respond(player, tracker.localize('eloTracker.onEloCommand.failedToRetrievePlayer'));
      }
    };

    // Admin in-game command handler
    // Registered on CHAT_COMMAND:eloadmin
    // Restricted to ChatAdmin channel only
    tracker.onEloAdminCommand = async function(info) {
      if (!this.ready) return;
      if (info.chat !== 'ChatAdmin') return;

      const args = (info.message || '')
        .replace(/^!eloadmin\s*/i, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const sub = args[0]?.toLowerCase();
      const player = info.player || { steamID: info.steamID, name: info.playerName };

      if (!sub || sub === 'help') {
        return await this.respond(player, [
          tracker.localize('eloTracker.onEloAdminCommand.elotrackerAdminCommands'),
          tracker.localize('eloTracker.onEloAdminCommand.eloadminResetNameSteamid'),
          tracker.localize('eloTracker.onEloAdminCommand.eloadminStatusPluginStatus'),
          tracker.localize('eloTracker.onEloAdminCommand.eloadminHelpShowThis')
        ].join('\n'));
      }

      // !eloadmin status
      if (sub === 'status') {
        const sessionCount = this.session.getSessionCount();
        const cacheCount = this.eloCache.size;
        return await this.respond(player, [
          tracker.localize('eloTracker.onEloAdminCommand.elotrackerStatus'),
          tracker.localize('eloTracker.onEloAdminCommand.versionVersion', { version: this.constructor.version }),
          tracker.localize('eloTracker.onEloAdminCommand.readyReady', { ready: this.ready }),
          tracker.localize('eloTracker.onEloAdminCommand.sessionPlayersSessioncount', { sessionCount }),
          tracker.localize('eloTracker.onEloAdminCommand.eloCacheEntriesCachecount', { cacheCount }),
          tracker.localize('eloTracker.onEloAdminCommand.roundStartValue', { value: this.session.roundStartTime ? new Date(this.session.roundStartTime).toISOString() : 'None' })
        ].join('\n'));
      }

      // !eloadmin reset <identifier>
      if (sub === 'reset') {
        const identifier = args.slice(1).join(' ');
        if (!identifier) {
          return await this.respond(player, tracker.localize('eloTracker.onEloAdminCommand.usageEloadminResetName'));
        }
        try {
          // Reset is destructive and irreversible, so unlike !elo it refuses to
          // act on a guess — see EloDatabase.isUnambiguous() for the rule.
          // Without this gate, `!eloadmin reset cerv` would wipe whichever
          // "cerv*" account the ranker happened to favour.
          const candidates = await this._findPlayerCandidates(identifier);
          const record = candidates.length ? candidates[0] : null;
          if (!record) {
            return await this.respond(player, tracker.localize('eloTracker.onEloAdminCommand.noPlayerFoundIdentifier', { identifier }));
          }
          if (!EloDatabase.isUnambiguous(candidates)) {
            const names = candidates.slice(0, 5)
              .map((p) => `${String(p.name || '?').trim()} (${p.roundsPlayed || 0} rds)`);
            return await this.respond(player, [
              tracker.localize('eloTracker.onEloAdminCommand.ambiguousIdentifierIsNot', { identifier }),
              tracker.localize('eloTracker.onEloAdminCommand.matchedNames', { names: names.join(', ') }),
              tracker.localize('eloTracker.onEloAdminCommand.reRunWithThe')
            ].join('\n'));
          }
          const defaults = { mu: EloCalculator.MU_DEFAULT, sigma: EloCalculator.SIGMA_DEFAULT, wins: 0, losses: 0, roundsPlayed: 0 };
          await this.db.upsertPlayerStats(record.eosID, defaults);
          if (this.eloCache.has(record.eosID)) { this.eloCache.set(record.eosID, { mu: defaults.mu, sigma: defaults.sigma }); }
          Logger.verbose('EloTracker', 2, `[EloCommands] Admin ${player.name} reset ELO for ${record.name}`);
          return await this.respond(player, tracker.localize('eloTracker.onEloAdminCommand.resetNameToDefault', { name: record.name, mu: defaults.mu }));
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] Reset failed: ${err.message}`);
          return await this.respond(player, tracker.localize('eloTracker.onEloAdminCommand.failedToResetPlayer', { message: err.message }));
        }
      }

      return await this.respond(player, tracker.localize('eloTracker.onEloAdminCommand.unknownCommandTypeEloadmin'));
    };
  }
};

export default EloCommands;