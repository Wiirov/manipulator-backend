// Room.js — pure data model + state helpers for a single game room.
// No socket/network code lives here, only game state, so it's easy to test/reason about.

import { randomInt } from 'node:crypto';

export const PHASES = {
  LOBBY: 'lobby',
  ROLLING: 'rolling',
  NIGHT: 'night',
  DAY: 'day',
  VOTING: 'voting',
  RESULTS: 'results',
};

const NIGHT_HOUR_DURATION_MS = 9000;
const DAY_DISCUSSION_MS = 180000;
const VOTING_DURATION_MS = 45000;
const TIE_BREAKER_DURATION_MS = 15000;
const MIN_PLAYERS = 5;

export class Room {
  constructor(code, hostPlayerId) {
    this.code = code;
    this.hostId = hostPlayerId;
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.jewelStolen = false;
    this.stolenAtHour = null;
    this.thiefId = null;
    this.assistantId = null;
    this.currentHour = 0;
    this.chatMessages = [];
    this.votes = new Map();
    this.nightTimer = null;
    this.phaseDeadline = null;
    this.createdAt = Date.now();
    this.settings = {
      nightHourDurationMs: NIGHT_HOUR_DURATION_MS,
      discussionDurationMs: DAY_DISCUSSION_MS,
      votingDurationMs: VOTING_DURATION_MS,
      tieBreakerDurationMs: TIE_BREAKER_DURATION_MS,
      maxHours: 6,
    };
    this.tieBreaker = null;
    this.actionLog = [];
  }

  addPlayer(playerId, name, options = {}) {
    const player = {
      id: playerId,
      socketId: options.socketId || null,
      name: String(name).slice(0, 20),
      ready: false,
      connected: true,
      hour: null,
      role: options.isSpectator ? 'spectator' : 'innocent',
      alive: true,
      hasRolled: false,
      hasActedThisHour: false,
      isSpectator: Boolean(options.isSpectator),
    };
    this.players.set(playerId, player);
    return player;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    this.votes.delete(playerId);
    if (this.hostId === playerId) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
  }

  get playerList() {
    return [...this.players.values()];
  }

  get playerCount() {
    return this.players.size;
  }

  get activePlayers() {
    return this.playerList.filter((p) => !p.isSpectator);
  }

  get activePlayerCount() {
    return this.activePlayers.length;
  }

  canStart() {
    return this.phase === PHASES.LOBBY && this.activePlayerCount >= MIN_PLAYERS;
  }

  static getRoleDistribution(playerCount) {
    const table = {
      5: { innocent: 3, thief: 1, assistant: 1 },
      6: { innocent: 4, thief: 1, assistant: 1 },
      7: { innocent: 4, thief: 1, assistant: 2 },
      8: { innocent: 5, thief: 2, assistant: 1 },
      9: { innocent: 5, thief: 2, assistant: 2 },
      10: { innocent: 6, thief: 2, assistant: 2 },
      11: { innocent: 6, thief: 2, assistant: 3 },
      12: { innocent: 7, thief: 2, assistant: 3 },
      13: { innocent: 7, thief: 3, assistant: 3 },
      14: { innocent: 8, thief: 3, assistant: 3 },
      15: { innocent: 8, thief: 3, assistant: 4 },
    };
    return table[playerCount] || { innocent: Math.max(0, playerCount - 2), thief: 1, assistant: 0 };
  }

  getRoleSummary() {
    return {
      thiefCount: Room.getRoleDistribution(this.activePlayerCount).thief,
      assistantCount: Room.getRoleDistribution(this.activePlayerCount).assistant,
    };
  }

  assignRoles() {
    this.thiefId = null;
    this.assistantId = null;
    const distribution = Room.getRoleDistribution(this.activePlayerCount);
    const rolePool = [];
    // Assistants are chosen by the thief during the night, not dealt at random.
    for (let i = 0; i < distribution.innocent + distribution.assistant; i += 1) rolePool.push('innocent');
    for (let i = 0; i < distribution.thief; i += 1) rolePool.push('thief');

    for (const player of this.activePlayers) {
      player.role = 'innocent';
      player.hour = null;
      player.hasRolled = false;
      player.hasActedThisHour = false;
    }

    for (const player of this.playerList.filter((p) => p.isSpectator)) {
      player.role = 'spectator';
    }

    const shuffled = [...rolePool];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const activePlayers = this.activePlayers;
    activePlayers.forEach((player, index) => {
      const role = shuffled[index] || 'innocent';
      player.role = role;
      if (role === 'thief') this.thiefId = player.id;
    });

    this.actionLog = [];
    this.actionLog.push({ type: 'roles_assigned', at: Date.now() });
    return this.thiefId;
  }

  assignThief() {
    return this.assignRoles();
  }

  rollDiceFor(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.hasRolled || player.isSpectator) return null;
    const maxHours = Math.min(10, Math.max(6, this.activePlayerCount));
    const hour = randomInt(1, maxHours + 1);
    player.hour = hour;
    player.hasRolled = true;
    return hour;
  }

  allPlayersRolled() {
    return this.activePlayers.every((p) => p.hasRolled);
  }

  playersAtHour(hour) {
    return this.activePlayers.filter((p) => p.hour === hour);
  }

  setAssistant(assistantId) {
    const assistant = this.players.get(assistantId);
    if (!assistant || assistant.isSpectator || assistant.id === this.thiefId) return false;
    if (assistant.role !== 'innocent') return false;
    this.assistantId = assistantId;
    assistant.role = 'assistant';
    this.actionLog.push({ type: 'assistant_selected', assistantId, at: Date.now() });
    return true;
  }

  stealJewel(hour) {
    this.jewelStolen = true;
    this.stolenAtHour = hour;
    this.actionLog.push({ type: 'jewel_stolen', at: Date.now(), hour });
  }

  addChatMessage(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) return null;
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      playerId,
      name: player.name,
      text: String(text).slice(0, 400),
      ts: Date.now(),
    };
    this.chatMessages.push(msg);
    return msg;
  }

  castVote(voterId, targetId) {
    const voter = this.players.get(voterId);
    const target = this.players.get(targetId);
    if (!voter || !target || voter.isSpectator) return false;
    if (this.tieBreaker?.active && !this.tieBreaker.candidates.includes(targetId)) return false;
    this.votes.set(voterId, targetId);
    return true;
  }

  allVoted() {
    return this.votes.size === this.activePlayerCount;
  }

  startTieBreaker() {
    const tiedIds = [...new Set(this.votes.values())];
    this.tieBreaker = {
      active: true,
      candidates: tiedIds,
      round: 1,
    };
    this.votes.clear();
  }

  tallyVotes() {
    const counts = new Map();
    for (const targetId of this.votes.values()) {
      counts.set(targetId, (counts.get(targetId) || 0) + 1);
    }
    let topId = null;
    let topCount = 0;
    let tie = false;
    for (const [id, count] of counts.entries()) {
      if (count > topCount) {
        topCount = count;
        topId = id;
        tie = false;
      } else if (count === topCount) {
        tie = true;
      }
    }
    const majorityThreshold = Math.floor(this.activePlayerCount / 2);
    const isMajority = !tie && topCount > majorityThreshold;
    const targetPlayer = this.players.get(topId);
    const targetRole = targetPlayer?.role || 'innocent';
    const innocentsWin = isMajority && topId === this.thiefId;
    const thievesWin = isMajority && (topId !== this.thiefId);
    return {
      counts: Object.fromEntries(counts),
      accusedId: tie ? null : topId,
      innocentsWin,
      thievesWin,
      tie,
      winner: innocentsWin ? 'innocents' : thievesWin ? 'thieves' : 'none',
      targetRole,
      tieBreakerCandidates: tie ? [...new Set(counts.keys())] : [],
    };
  }

  updateSettings(nextSettings) {
    this.settings = {
      ...this.settings,
      ...nextSettings,
      maxHours: Math.min(10, Math.max(6, Number(nextSettings.maxHours || this.settings.maxHours))),
    };
  }

  getVoteSummary() {
    const summary = [];
    const counts = this.tallyVotes().counts;
    for (const player of this.activePlayers) {
      summary.push({ id: player.id, name: player.name, votes: counts[player.id] || 0 });
    }
    return summary.sort((a, b) => b.votes - a.votes);
  }

  publicState(forId = null) {
    const self = this.players.get(forId);
    const isSpectator = self?.isSpectator;
    const revealRoles = this.phase === PHASES.RESULTS || isSpectator;
    let partner = null;
    if (self && !isSpectator) {
      if (self.role === 'thief' && this.assistantId) {
        const assistant = this.players.get(this.assistantId);
        if (assistant) partner = { id: assistant.id, role: 'assistant', name: assistant.name };
      } else if (self.role === 'assistant' && this.thiefId) {
        const thief = this.players.get(this.thiefId);
        if (thief) partner = { id: thief.id, role: 'thief', name: thief.name };
      }
    }

    const partnerId = partner?.id || null;
    const showSameHour = Boolean(self?.hour && !isSpectator && this.phase !== PHASES.LOBBY);
    const sameHourPlayers = showSameHour
      ? this.activePlayers
          .filter((p) => {
            if (p.id === forId || p.id === partnerId) return false;
            if (p.hour !== self.hour) return false;
            if (this.phase === PHASES.ROLLING && !p.hasRolled) return false;
            return true;
          })
          .map((p) => ({ id: p.id, name: p.name }))
      : [];

    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      selfPlayerId: forId,
      activePlayerCount: this.activePlayerCount,
      settings: this.settings,
      roleSummary: this.getRoleSummary(),
      partner,
      sameHourPlayers,
      jewelStolen: this.phase === PHASES.DAY || this.phase === PHASES.VOTING || this.phase === PHASES.RESULTS
        ? this.jewelStolen
        : false,
      currentHour: this.currentHour,
      phaseDeadline: this.phaseDeadline,
      tieBreaker: this.tieBreaker,
      players: this.playerList.map((p) => {
        const ownHour = p.id === forId;
        const showHour = isSpectator || this.phase === PHASES.RESULTS || ownHour;
        let hour = null;
        if (this.phase === PHASES.LOBBY || this.phase === PHASES.ROLLING) {
          hour = p.id === forId || isSpectator ? p.hour : (p.hasRolled ? true : null);
        } else if (this.phase === PHASES.DAY) {
          hour = showHour ? p.hour : null;
        } else {
          hour = p.hour;
        }
        return {
          id: p.id,
          name: p.name,
          ready: p.ready,
          connected: p.connected,
          alive: p.alive,
          isSpectator: p.isSpectator,
          hour,
          role: revealRoles || p.id === forId ? p.role : undefined,
        };
      }),
      voteSummary: this.phase === PHASES.VOTING || this.phase === PHASES.RESULTS ? this.getVoteSummary() : undefined,
    };
  }

  resetTimers() {
    if (this.nightTimer) {
      clearTimeout(this.nightTimer);
      this.nightTimer = null;
    }
  }
}

export const CONFIG = {
  MIN_PLAYERS,
  NIGHT_HOUR_DURATION_MS,
  DAY_DISCUSSION_MS,
  VOTING_DURATION_MS,
  TIE_BREAKER_DURATION_MS,
};
