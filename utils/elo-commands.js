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
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Methods are attached directly onto the tracker instance, not
 *   returned as standalone functions. They rely on tracker.server,
 *   tracker.db, tracker.session, tracker.eloCache, and tracker.options.
 * - onEloAdminCommand enforces ChatAdmin channel restriction internally.
 *   The caller must still register the event listener.
 * - !eloadmin reset resets mu, sigma, wins, losses, and roundsPlayed
 *   to defaults. It does NOT delete the DB record.
 * - !elo with no sub-command shows the caller's own rating.
 * - !elo <name|steamID> looks up another player.
 * - Unknown sub-commands show help text (Stage 8.3 fix).
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
      const record = await trackerCtx._findPlayerByIdentifier(identifier);
      if (!record) {
        return await trackerCtx.respond(player, [
          `No ELO record found for: ${identifier}`,
          'Type !elo help for available commands.'
        ].join('\n'));
      }

      const minRounds = trackerCtx.options.minRoundsForLeaderboard;
      let rankLine;
      const consRating = record.mu - (EloCalculator.SIGMA_MULTIPLIER * record.sigma);
      if (record.roundsPlayed < minRounds) {
        rankLine = `Rank: Provisional (${record.roundsPlayed}/${minRounds} rounds)`;
      } else {
        const rank = await trackerCtx.db.getPlayerRank(consRating, minRounds);
        const total = await trackerCtx.db.getTotalPlayers();
        rankLine = `Rank: #${rank} (of ${total} total)`;
      }

      return await trackerCtx.respond(player, [
        `=== ${record.name} ===`,
        rankLine,
        `CSR: ${consRating.toFixed(2)} (μ - 3.0σ)`,
        `Estimated Skill: ${record.mu.toFixed(2)} μ | Certainty: ${record.sigma.toFixed(2)} σ`,
        `Record: ${record.wins}W / ${record.losses}L (${record.roundsPlayed} rounds)`
      ].join('\n'));
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
          '=== EloTracker Commands ===',
          '!elo — Show your current rating and rank',
          '!elo <name | steamID> — Look up another player',
          '!elo leaderboard — Top 10 players by rating',
          '!elo help — Show this message'
        ].join('\n'));
      }

      // !elo leaderboard
      if (sub === 'leaderboard') {
        try {
          const players = await this.db.getLeaderboard(10, this.options.minRoundsForLeaderboard);
          if (!players.length) {
            return await this.respond(player, 'No leaderboard data yet.');
          }
          const lines = players.map((p, i) => {
            const consRating = p.mu - (EloCalculator.SIGMA_MULTIPLIER * p.sigma);
            return `#${(i + 1).toString().padStart(2, ' ')} ${p.name.trim()}: ${consRating.toFixed(1)} ${p.wins}W/${p.losses}L`;
          });
          return await this.respond(player, ['=== ELO Leaderboard ===', ...lines].join('\n'));
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] Leaderboard failed: ${err.message}`);
          return await this.respond(player, 'Failed to retrieve leaderboard.');
        }
      }

      // !elo (no args) — self lookup
      if (!sub) {
        const identifier = player.steamID || player.eosID;
        try {
          return await _lookupAndRespond(this, player, identifier);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] Player lookup failed: ${err.message}`);
          return await this.respond(player, 'Failed to retrieve player stats.');
        }
      }

      // !elo <identifier> — lookup another player by name/steamID
      const identifier = args.join(' ');
      try {
        return await _lookupAndRespond(this, player, identifier);
      } catch (err) {
        Logger.verbose('EloTracker', 1, `[EloCommands] Player lookup failed: ${err.message}`);
        return await this.respond(player, 'Failed to retrieve player stats.');
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
          '=== EloTracker Admin Commands ===',
          '!eloadmin reset <name|steamID|eosID> — Reset a player to default rating',
          '!eloadmin status — Plugin status and current round info',
          '!eloadmin help — Show this message'
        ].join('\n'));
      }

      // !eloadmin status
      if (sub === 'status') {
        const sessionCount = this.session.getSessionCount();
        const cacheCount = this.eloCache.size;
        return await this.respond(player, [
          '=== EloTracker Status ===',
          `Version: ${this.constructor.version}`,
          `Ready: ${this.ready}`,
          `Session players: ${sessionCount}`,
          `ELO cache entries: ${cacheCount}`,
          `Round start: ${this.session.roundStartTime ? new Date(this.session.roundStartTime).toISOString() : 'None'}`
        ].join('\n'));
      }

      // !eloadmin reset <identifier>
      if (sub === 'reset') {
        const identifier = args.slice(1).join(' ');
        if (!identifier) {
          return await this.respond(player, 'Usage: !eloadmin reset <name | steamID | eosID>');
        }
        try {
          const record = await this._findPlayerByIdentifier(identifier);
          if (!record) {
            return await this.respond(player, `No player found: ${identifier}`);
          }
          const defaults = { mu: EloCalculator.MU_DEFAULT, sigma: EloCalculator.SIGMA_DEFAULT, wins: 0, losses: 0, roundsPlayed: 0 };
          await this.db.upsertPlayerStats(record.eosID, defaults);
          if (this.eloCache.has(record.eosID)) { this.eloCache.set(record.eosID, { mu: defaults.mu, sigma: defaults.sigma }); }
          Logger.verbose('EloTracker', 2, `[EloCommands] Admin ${player.name} reset ELO for ${record.name}`);
          return await this.respond(player, `Reset ${record.name} to default rating (μ ${defaults.mu}).`);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] Reset failed: ${err.message}`);
          return await this.respond(player, `Failed to reset player: ${err.message}`);
        }
      }

      return await this.respond(player, 'Unknown command. Type !eloadmin help for options.');
    };
  }
};

export default EloCommands;