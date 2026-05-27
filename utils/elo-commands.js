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
 * - !elo with no sub-command falls through to the player lookup
 *   path using the full args string as the identifier.
 *
 *   Calculates and displays a "Competitive Skill Rank" (CSR) (μ - 3.0σ)
 *   as the primary player rank to encourage active play.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';

const SIGMA_MULTIPLIER = 3.0;

const EloCommands = {
  register(tracker) {

    // Shared respond helper — wraps rcon.warn with logging
    tracker.respond = async function(player, msg) {
      const name = player?.name || 'Unknown';
      const steamID = player?.steamID;
      Logger.verbose('EloTracker', 2, `[Response to ${name} (${steamID || 'Unknown'})]\n${msg}`);
      if (steamID) {
        try {
          await this.server.rcon.warn(steamID, msg);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `[EloCommands] rcon.warn failed for ${steamID}: ${err.message}`);
        }
      }
      return msg;
    };

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

      // !elo (no args) or !elo <identifier> — lookup
      const identifier = sub ? args.join(' ') : (player.steamID || player.eosID);
      try {
        const record = await this._findPlayerByIdentifier(identifier);
        if (!record) {
          return await this.respond(player, `No ELO record found for: ${identifier}`);
        }

        const minRounds = this.options.minRoundsForLeaderboard;
        let rankLine;
        const consRating = record.mu - (EloCalculator.SIGMA_MULTIPLIER * record.sigma);
        if (record.roundsPlayed < minRounds) {
          rankLine = `Rank: Provisional (${record.roundsPlayed}/${minRounds} rounds)`;
        } else {
          const rank = await this.db.getPlayerRank(consRating, minRounds);
          const total = await this.db.getTotalPlayers();
          rankLine = `Rank: #${rank} (of ${total} total)`;
        }

        return await this.respond(player, [
          `=== ${record.name} ===`,
          rankLine,
          `CSR: ${consRating.toFixed(2)} (μ - 3.0σ)`,
          `Estimated Skill: ${record.mu.toFixed(2)} μ | Certainty: ${record.sigma.toFixed(2)} σ`,
          `Record: ${record.wins}W / ${record.losses}L (${record.roundsPlayed} rounds)`
        ].join('\n'));
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