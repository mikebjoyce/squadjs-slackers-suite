/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN — SQUAD PARTIES                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Squad's parties tie players' teams together: force-moving a party's
 * leader takes the whole party along, and force-moving any other
 * member takes only that member and leaves the party split across
 * teams. RCON does not say who leads. So a !switch from a party member
 * cannot be served as one move: either it splits their party, or it
 * moves players nobody checked the balance for.
 *
 * This file makes a party switch a single request for the whole
 * party. Every member on the requester's team is checked, the balance
 * gate is asked about all of them at once, and they are moved one at
 * a time, each to a stated team, so the result is the same whichever
 * of them leads.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SwitchParties (default)
 *   Singleton with a single register(plugin) method. Attaches:
 *     _partyForSwitch(eosID)            — the player's party (2+), or null
 *     _partyMovers(party, teamID)       — its members on one team
 *     _handlePartySwitchRequest(...)    — the !switch path for a party member
 *     _switchParty({ movers, ... })     — move, verify, charge tokens
 *     _enqueueParty(...)                — one queue entry for the group
 *     _servePartyQueueEntry(entry, ...) — the queue's side of a group entry
 *     _cancelIfPartyChanged(entry)      — drop a queue entry a party change voided
 *     _sweepPartyQueueEntries()         — the same, over the whole queue
 *     _startPartyWatch() / _stopPartyWatch()
 *     _partyNotice(eosIDs)              — text for an admin moving party members
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * No imports. Everything is reached through plugin.* (the live plugin
 * instance passed to register()). Needs the queue methods from
 * switch-queue.js, so register that first.
 *
 * S³ PlayersService: getParty(), getPlayer(), canAct(),
 * onPartiesChanged(). All optional-chained: against an S³ without
 * party tracking, no player is ever in a party and nothing here runs.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Movers are the party members on the requester's team. A party
 *   already split across teams is reunited by one of its members
 *   asking: the half on the other side is where they are going.
 * - Lockouts are the party's, tokens are not. One member under
 *   scramble lockdown, the post-switch lockout or a closed time window
 *   bars the whole party, or a locked player would get out by partying
 *   with a free friend. Tokens never bar a party: each member who moves
 *   pays one, and a member with none still moves and stays at zero.
 * - The refusal for another member's lockout names nobody.
 * - A queue entry is cancelled, not repaired, when the party behind it
 *   changes. Re-checking a changed group (new size, new lockouts) is
 *   the same work as a fresh request, so the players are asked to make
 *   one. A solo entry is cancelled the same way once its player joins
 *   a party, since serving it would move one member of a party.
 * - Round stats gain no bucket: a party switch is one entry in the
 *   bucket a solo switch would use, carrying partySize, and a
 *   cancellation is a queueRemovals entry with reason 'joined_party'
 *   or 'party_changed'.
 * - Moves are tagged 'Player-Self' and 'Player-Queue' like solo ones.
 *   S³'s switch reports group by those exact strings.
 *
 * ═══════════════════════════════════════════════════════════════
 */

const SwitchParties = {
  /**
   * Attaches the party methods and state to the plugin instance.
   * Adds: plugin._unsubscribePartiesChanged.
   *
   * @param {object} plugin — the live Switch plugin instance
   */
  register(plugin) {
    plugin._unsubscribePartiesChanged = null;

    const sameMembers = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
    const gamePhaseNow = () => plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';

    // ── Lookups ────────────────────────────────────────────────

    /**
     * The party a switch request has to treat as a group, or null.
     * A party ID with nobody else behind it is a solo player.
     */
    plugin._partyForSwitch = function (eosID) {
      const party = plugin._s3?.players?.getParty?.(eosID) ?? null;
      return party && (party.members?.length ?? 0) >= 2 ? party : null;
    };

    /** S³ rows of the party's members who are on `teamID` right now. */
    plugin._partyMovers = function (party, teamID) {
      const s3Players = plugin._s3?.players;
      const movers = [];
      for (const id of party?.members ?? []) {
        const row = s3Players?.getPlayer?.(id);
        if (row && row.teamID === teamID) movers.push(row);
      }
      return movers;
    };

    // ── The request ────────────────────────────────────────────

    /**
     * !switch from a player who is in a party.
     *
     * Replaces the solo path from the eligibility check onward. The caller
     * has already refreshed the player list and ruled out the faction vote.
     *
     * @param {object} player — the requester, from the chat event
     * @param {number} teamID — the requester's team per S³
     * @param {object} party — from _partyForSwitch()
     */
    plugin._handlePartySwitchRequest = async function (player, teamID, party) {
      const eosID = player.eosID;
      const playerName = player.name;
      const targetTeam = teamID === 1 ? 2 : 1;

      // One entry per party: a second member asking is told where it stands.
      // An entry the party has changed under (a solo entry from before the
      // player joined, say) is cancelled here and the request goes ahead.
      const queued = plugin._findQueueEntry(eosID);
      if (queued && !plugin._cancelIfPartyChanged(queued.entry)) {
        const remaining = (plugin._getRemainingQueueMs(queued.entry.queuedAt) / 60000).toFixed(1);
        plugin.warn(eosID, plugin.localize('switch.warn.partyAlreadyQueued', {
          pos: queued.index + 1, remaining, currentTeamID: queued.entry.currentTeamID, targetTeamID: queued.entry.targetTeamID
        }));
        return;
      }

      const movers = plugin._partyMovers(party, teamID);
      if (!movers.some((m) => m.eosID === eosID)) {
        plugin.verbose(1, `[Party] ${playerName}: not on Team ${teamID} per S³. Request dropped.`);
        return;
      }
      const size = movers.length;
      const isLiberal = plugin.isLiberalMode();

      if (!isLiberal && size > plugin.options.maxPartySwitchSize) {
        plugin.warn(eosID, plugin.localize('switch.warn.partyTooLarge', { size, max: plugin.options.maxPartySwitchSize }));
        plugin.verbose(1, `[Party] Denied ${playerName}: party of ${size} is over maxPartySwitchSize (${plugin.options.maxPartySwitchSize}).`);
        plugin._trackDenial(eosID, playerName, 'party_too_large');
        return;
      }

      // The requester first, so their own lockout is the one they hear about.
      const ordered = [...movers].sort((a, b) => (b.eosID === eosID) - (a.eosID === eosID));
      for (const mover of ordered) {
        const eligibility = await plugin._checkSwitchEligibility(mover);
        // 'cooldown' means out of tokens. That never stops a party.
        if (eligibility.eligible || eligibility.reason === 'cooldown') continue;

        if (mover.eosID !== eosID) {
          plugin.warn(eosID, plugin.localize('switch.warn.partyMemberLockedOut'));
        } else if (eligibility.reason === 'recent_switch') {
          plugin.warn(eosID, plugin.localize('switch.warn.switchJustSwitchedWait', { remaining: eligibility.remaining }));
        } else if (eligibility.reason === 'scramble_lock') {
          plugin.warn(eosID, plugin.localize('switch.warn.switchScrambleLockActive', { remaining: eligibility.remaining }));
        } else if (eligibility.reason === 'time_window') {
          plugin.warn(eosID, plugin.localize('switch.warn.switchEligibilityWindowClosed', { switchEnabledMinutes: plugin.options.switchEnabledMinutes }));
        } else {
          plugin.warn(eosID, plugin.localize('switch.warn.partyMemberLockedOut'));
        }
        plugin.verbose(1, `[Party] Denied ${playerName}: ${mover.name} is locked out (${eligibility.reason}).`);
        plugin._trackDenial(eosID, playerName, eligibility.reason);
        return;
      }

      // Soft gate, as on the solo path: another plugin holding a lock on any
      // mover defers the request to the queue.
      const s3Players = plugin._s3?.players;
      if (s3Players?.isReady?.() && s3Players.canAct && movers.some((m) => !s3Players.canAct(m.eosID, 'Switch'))) {
        if (!plugin.options.queueEnabled) {
          plugin.warn(eosID, plugin.localize('switch.warn.switchPleaseTryAgain'));
          return;
        }
        plugin.verbose(1, `[Party] ${playerName}: a party member is locked by another plugin. Enqueuing.`);
        await plugin._enqueueParty(player, party, movers, plugin.localize('switch.labels.queueReasonQueued'));
        return;
      }

      const effectiveCap = isLiberal ? plugin.options.liberalSwitchMaxUnbalancedSlots : null;
      const fits = plugin.getSwitchGroupSlots(teamID, size, effectiveCap) >= size;
      plugin.verbose(2, `[Party Request] ${playerName} +${size - 1} (T${teamID} -> T${targetTeam}) | fits=${fits}`);

      if (!plugin.options.queueEnabled) {
        if (!fits) {
          plugin.warn(eosID, plugin.localize('switch.warn.switchQueueCurrentlyDisabled'));
          return;
        }
      } else {
        // FIFO, as on the solo path: nobody jumps players already waiting.
        if (plugin._switchQueue[teamID === 1 ? 't1' : 't2'].length > 0) {
          await plugin._enqueueParty(player, party, movers, plugin.localize('switch.labels.queueReasonOthersWaiting'));
          return;
        }
        if (!fits) {
          await plugin._enqueueParty(player, party, movers, plugin.localize('switch.labels.queueReasonPartyNoRoom'));
          return;
        }
      }

      const outcome = await plugin._switchParty({ requesterEosID: eosID, movers, targetTeamID: targetTeam, source: 'Player-Self' });
      if (outcome.moved.length === 0) return;

      plugin._trackRoundStat('instantSwitches', {
        name: plugin._partyLabel(playerName, outcome.moved.length),
        eosID,
        fromTeam: teamID,
        toTeam: targetTeam,
        partySize: outcome.moved.length,
        gamePhase: gamePhaseNow()
      });
      if (plugin._roundStats) plugin._updateMaxQueueSize();
      plugin.verbose(1, `[Party] Executed for ${playerName}: ${outcome.moved.length} of ${size} moved to T${targetTeam}.`);
    };

    /** "Name +2" for logs and round stats: one line for one request. */
    plugin._partyLabel = function (name, size) {
      return size > 1 ? `${name} +${size - 1}` : `${name}`;
    };

    // ── The move ───────────────────────────────────────────────

    /**
     * Move a party's members to one team, then settle up.
     *
     * One at a time, never together: AdminForceTeamChange toggles, and a
     * leader's move drags the party, so two commands in flight can undo each
     * other. Each move states the target, so a member the leader's move
     * already carried across is found there and costs no command.
     *
     * Nobody is moved back. If some members could not be moved the requester
     * is told, and the party is left split for them to sort out.
     *
     * @returns {Promise<{moved: object[], stayed: object[]}>}
     */
    plugin._switchParty = async function ({ requesterEosID, movers, targetTeamID, source }) {
      for (const mover of movers) {
        try {
          await plugin._taggedSwitchPlayer(mover.eosID, source, targetTeamID);
        } catch (err) {
          plugin.verbose(1, `[Party] Move failed for ${mover.name}: ${err.message}`);
        }
      }

      const s3Players = plugin._s3?.players;
      const moved = [];
      const stayed = [];
      for (const mover of movers) {
        const row = s3Players?.getPlayer?.(mover.eosID);
        if (row && row.teamID === targetTeamID) moved.push(mover);
        else stayed.push(mover);
      }

      const isLiberal = plugin.isLiberalMode();
      for (const mover of moved) {
        plugin._recordRecentSwitch(mover.eosID);
        plugin.warn(mover.eosID, plugin.localize('switch.warn.partySwitched', { teamID: targetTeamID }));
        if (isLiberal) continue;
        const wallet = await plugin._spendPartyToken(mover);
        if (wallet && plugin.options.maxSwitchTokens > 1) {
          if (wallet.balance > 0) {
            plugin.warn(mover.eosID, plugin.localize('switch.warn.switchSwitchedTokensRemaining', { balance: wallet.balance, maxSwitchTokens: plugin.options.maxSwitchTokens }));
          } else {
            const cooldownDuration = plugin.options.switchCooldownMinutes > 0
              ? plugin.options.switchCooldownMinutes * 60 * 1000
              : plugin.options.switchCooldownHours * 60 * 60 * 1000;
            const anchor = wallet.anchor ? new Date(wallet.anchor).getTime() : Date.now();
            const remaining = Math.ceil((cooldownDuration - (Date.now() - anchor)) / 60000);
            plugin.warn(mover.eosID, plugin.localize('switch.warn.switchSwitchedReOut', { remaining }));
          }
        }
      }

      if (stayed.length > 0) {
        plugin.verbose(1, `[Party] Partial move to T${targetTeamID}: moved ${moved.map((m) => m.name).join(', ') || 'nobody'}; not moved ${stayed.map((m) => m.name).join(', ')}.`);
        if (requesterEosID) {
          plugin.warn(requesterEosID, moved.length > 0
            ? plugin.localize('switch.warn.partySwitchedPartial', { moved: moved.length, total: movers.length })
            : plugin.localize('switch.warn.switchServerCouldNot'));
        }
      }

      return { moved, stayed };
    };

    /**
     * Charge one token: load, regen, spend, upsert. A wallet at zero stays at
     * zero. Returns the wallet after the spend, or null when it was not
     * written (no model, or the DB is down).
     */
    plugin._spendPartyToken = async function (mover) {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) return null;
      try {
        let wallet = null;
        await plugin._withDb(async (t) => {
          // Locked for the transaction for the same reason the solo path
          // locks it: the wallet is community-wide, and two servers reading
          // the same balance would both spend it.
          let row = await PlayerCooldowns.findByPk(mover.eosID, { lock: t?.LOCK?.UPDATE, transaction: t });
          if (!row) {
            row = { eosID: mover.eosID, steamID: mover.steamID, playerName: mover.name, tokenBalance: plugin.options.maxSwitchTokens, tokenRegenAnchor: null };
          }
          plugin._regenTokens(row);
          plugin._spendToken(row);
          await PlayerCooldowns.upsert(
            { eosID: mover.eosID, steamID: mover.steamID, playerName: mover.name, tokenBalance: row.tokenBalance, tokenRegenAnchor: row.tokenRegenAnchor, lastActiveTimestamp: new Date() },
            { transaction: t }
          );
          wallet = { balance: row.tokenBalance, anchor: row.tokenRegenAnchor };
        });
        return wallet;
      } catch (dbErr) {
        plugin.verbose(1, `[Party] Token spend failed for ${mover.name}: ${dbErr.message}`);
        return null;
      }
    };

    // ── The queue ──────────────────────────────────────────────

    /**
     * Queue the party as one entry. `eosID`, `steamID` and `playerName` are
     * the requester's, so everything that reads a queue entry by those keeps
     * working; `memberEosIDs` is who moves, and both member lists are the
     * snapshot _cancelIfPartyChanged() compares against.
     */
    plugin._enqueueParty = async function (requester, party, movers, reason) {
      if (!plugin.options.queueEnabled) {
        plugin.verbose(2, `[Queue] Queue disabled — refusing party enqueue for ${requester.name}.`);
        return;
      }

      const teamID = movers[0].teamID;
      const targetTeam = teamID === 1 ? 2 : 1;
      const subQueue = teamID === 1 ? 't1' : 't2';
      const memberEosIDs = movers.map((m) => m.eosID);
      const queuedAt = Date.now();

      const warnInterval = setInterval(() => {
        const found = plugin._findQueueEntry(requester.eosID);
        if (!found || found.entry.kind !== 'party') { clearInterval(warnInterval); return; }
        const remaining = (plugin._getRemainingQueueMs(found.entry.queuedAt) / 60000).toFixed(1);
        for (const id of found.entry.memberEosIDs) {
          plugin.warn(id, plugin.localize('switch.warn.partyQueuePosition', {
            pos: found.index + 1, remaining, currentTeamID: found.entry.currentTeamID, targetTeamID: found.entry.targetTeamID
          }));
        }
      }, 30_000);

      const enqueuePos = plugin._switchQueue[subQueue].length + 1;
      const entry = {
        kind: 'party',
        partyKey: party.key,
        requesterEosID: requester.eosID,
        memberEosIDs,
        partyMemberEosIDs: [...party.members],
        size: memberEosIDs.length,
        eosID: requester.eosID,
        steamID: requester.steamID,
        playerName: plugin._partyLabel(requester.name, memberEosIDs.length),
        currentTeamID: teamID,
        targetTeamID: targetTeam,
        queuedAt,
        warnInterval
      };
      plugin._switchQueue[subQueue].push(entry);
      plugin._updateMaxQueueSize();

      const remainingQueueMs = (plugin._getRemainingQueueMs(queuedAt) / 60000).toFixed(1);
      for (const id of memberEosIDs) {
        plugin.warn(id, plugin.localize('switch.warn.partyQueueAdded', { size: entry.size, enqueuePos, remainingQueueMs, teamID, targetTeam, reason }));
      }
      plugin.verbose(1, `[Queue] Party ${entry.playerName} (T${teamID} → T${targetTeam}) enqueued at position ${enqueuePos}. Queue size: ${plugin._getQueueSize()}`);

      if (plugin._getQueueSize() === 1) plugin._activateQueueProcessing();
      plugin._requestQueueRefresh();
    };

    /**
     * What a party change did to a queue entry, or null if it still stands.
     *
     *   'joined_party'  — a solo entry whose player is now in a party
     *   'party_changed' — a group entry whose party gained or lost a member,
     *                     dissolved, or no longer has the same members on the
     *                     team it was queued from (one left, or was moved)
     */
    plugin._partyEntryChange = function (entry) {
      if (entry.kind !== 'party') {
        return plugin._partyForSwitch(entry.eosID) ? 'joined_party' : null;
      }
      const party = plugin._partyForSwitch(entry.requesterEosID);
      if (!party || party.key !== entry.partyKey) return 'party_changed';
      if (!sameMembers(party.members, entry.partyMemberEosIDs)) return 'party_changed';
      const moversNow = plugin._partyMovers(party, entry.currentTeamID).map((m) => m.eosID);
      return sameMembers(moversNow, entry.memberEosIDs) ? null : 'party_changed';
    };

    /**
     * Cancel a queue entry that a party change has voided.
     *
     * Called from two places, and both are needed: the parties-changed
     * subscription, so players hear promptly, and the queue just before it
     * moves anyone, because a tick can land between that notice and the move.
     *
     * @returns {boolean} true when the entry is void and must not be served,
     *   whether this call removed it or an earlier one already had.
     */
    plugin._cancelIfPartyChanged = function (entry) {
      const change = plugin._partyEntryChange(entry);
      if (!change) return false;

      const found = plugin._findQueueEntry(entry.eosID);
      if (!found || found.entry !== entry) return true;
      plugin._removePlayerFromQueue(entry.eosID);

      const s3Players = plugin._s3?.players;
      const recipients = new Set(entry.kind === 'party' ? entry.memberEosIDs : [entry.eosID]);
      if (entry.kind === 'party') {
        for (const id of plugin._partyForSwitch(entry.requesterEosID)?.members ?? []) recipients.add(id);
      }
      const message = change === 'joined_party'
        ? plugin.localize('switch.warn.partyQueueCancelledJoined')
        : plugin.localize('switch.warn.partyQueueCancelledChanged');
      for (const id of recipients) {
        if (s3Players?.getPlayer?.(id)) plugin.warn(id, message);
      }

      plugin._trackRoundStat('queueRemovals', { name: entry.playerName, eosID: entry.eosID, reason: change, gamePhase: gamePhaseNow() });
      plugin.verbose(1, `[Queue] ${entry.playerName} removed from queue: ${change}.`);
      return true;
    };

    /** Run _cancelIfPartyChanged over every queue entry. */
    plugin._sweepPartyQueueEntries = function () {
      for (const entry of [...plugin._switchQueue.t1, ...plugin._switchQueue.t2]) {
        plugin._cancelIfPartyChanged(entry);
      }
    };

    /**
     * The queue's side of a group entry: serve it if every member can move.
     *
     * A group is all or nothing. Until the balance gate has room for all of
     * them it waits, and the queue is free to serve a solo entry behind it.
     *
     * @param {object} entry — a queue entry with kind 'party'
     * @param {boolean} timedOut — the queue-timeout relaxation applies
     * @returns {Promise<'served'|'cancelled'|'waiting'>}
     */
    plugin._servePartyQueueEntry = async function (entry, timedOut) {
      if (plugin._cancelIfPartyChanged(entry)) return 'cancelled';

      let effectiveCap = plugin.isLiberalMode() ? plugin.options.liberalSwitchMaxUnbalancedSlots : null;
      let skipHardCap = false;
      if (timedOut) {
        effectiveCap = plugin.options.maxUnbalancedSlots + plugin.getDynamicExtraSlots() + plugin.options.queueTimeoutExtraSlots;
        skipHardCap = true;
      }
      if (plugin.getSwitchGroupSlots(entry.currentTeamID, entry.size, effectiveCap, skipHardCap) < entry.size) return 'waiting';

      const s3Players = plugin._s3?.players;
      if (entry.memberEosIDs.some((id) => !s3Players?.canAct?.(id, 'Switch'))) {
        plugin.verbose(2, `[Queue] Party switch deferred for ${entry.playerName} — higher-priority lock held.`);
        return 'waiting';
      }

      const movers = entry.memberEosIDs.map((id) => s3Players.getPlayer(id)).filter(Boolean);
      plugin._removePlayerFromQueue(entry.eosID);
      for (const id of entry.memberEosIDs) {
        plugin.warn(id, timedOut ? plugin.localize('switch.warn.partyQueueTimeout') : plugin.localize('switch.warn.partyQueueSlotOpened'));
      }

      const outcome = await plugin._switchParty({ requesterEosID: entry.eosID, movers, targetTeamID: entry.targetTeamID, source: 'Player-Queue' });

      if (plugin._roundStats && outcome.moved.length > 0) {
        const queueDurationSeconds = Math.round((Date.now() - entry.queuedAt) / 1000);
        plugin._trackRoundStat(timedOut ? 'queueTimeoutSwitches' : 'queueNormal', {
          name: entry.playerName,
          eosID: entry.eosID,
          currentTeamID: entry.currentTeamID,
          toTeam: entry.targetTeamID,
          partySize: outcome.moved.length,
          queueDurationSeconds,
          gamePhase: gamePhaseNow()
        });
        if (!timedOut) plugin._roundStats.queueDurationsMs.push(queueDurationSeconds * 1000);
      }
      plugin.verbose(1, `[Queue] ${timedOut ? 'Timeout party switch' : 'Party switch'} fired for ${entry.playerName} (T${entry.currentTeamID})`);
      return 'served';
    };

    // ── Watching for changes ───────────────────────────────────

    /** Subscribe to S³'s party changes. Safe to call twice, and on an S³ without parties. */
    plugin._startPartyWatch = function () {
      if (plugin._unsubscribePartiesChanged) return;
      const s3Players = plugin._s3?.players;
      if (typeof s3Players?.onPartiesChanged !== 'function') return;
      plugin._unsubscribePartiesChanged = s3Players.onPartiesChanged(() => {
        try {
          if (plugin._getQueueSize() > 0) plugin._sweepPartyQueueEntries();
        } catch (err) {
          plugin.verbose(1, `[Party] Queue sweep after a party change failed: ${err.message}`);
        }
      });
    };

    plugin._stopPartyWatch = function () {
      if (typeof plugin._unsubscribePartiesChanged === 'function') plugin._unsubscribePartiesChanged();
      plugin._unsubscribePartiesChanged = null;
    };

    // ── Admin moves ────────────────────────────────────────────

    /**
     * What an admin should know before a move of these players lands.
     *
     * Admin tools move exactly who the admin named. If one of them leads a
     * party, the game moves the rest of it too, and nothing in RCON says
     * which member leads. So the admin is told who is tied to whom. Mates
     * who are in the moved set themselves are left out: they are moving
     * anyway.
     *
     * @param {string[]} eosIDs — the players about to be moved
     * @returns {string|null} one line per affected player, or null
     */
    plugin._partyNotice = function (eosIDs) {
      const s3Players = plugin._s3?.players;
      const moving = new Set(eosIDs);
      const nameOf = (id) => s3Players?.getPlayer?.(id)?.name ?? id;
      const lines = [];
      for (const id of eosIDs) {
        const party = plugin._partyForSwitch(id);
        if (!party) continue;
        const mates = party.members.filter((m) => m !== id && !moving.has(m));
        if (mates.length === 0) continue;
        lines.push(plugin.localize('switch.warn.adminPartyNotice', { name: nameOf(id), mates: mates.map(nameOf).join(', ') }));
      }
      return lines.length > 0 ? lines.join('\n') : null;
    };
  }
};

export default SwitchParties;
