// Room.js — pure data model + state helpers for a single game room.
// No socket/network code lives here, only game state, so it's easy to test/reason about.

export const PHASES = {
  LOBBY: 'lobby',
  ROLLING: 'rolling',
  NIGHT: 'night',
  DAY: 'day',
  VOTING: 'voting',
  RESULTS: 'results',
};

const NIGHT_HOUR_DURATION_MS = 9000; // how long each "hour" stays revealed
const DAY_DISCUSSION_MS = 180000; // 3 minutes discussion
const VOTING_DURATION_MS = 45000;
const MIN_PLAYERS = 5;

export class Room {
  constructor(code, hostSocketId) {
    this.code = code;
    this.hostId = hostSocketId;
    this.phase = PHASES.LOBBY;
    this.players = new Map(); // socketId -> playerObject
    this.jewelStolen = false;
    this.stolenAtHour = null;
    this.thiefId = null;
    this.assistantId = null;
    this.currentHour = 0;
    this.chatMessages = [];
    this.votes = new Map(); // voterId -> targetId
    this.nightTimer = null;
    this.phaseDeadline = null; // epoch ms, used by clients for countdown UI
    this.createdAt = Date.now();
  }

  addPlayer(socketId, name) {
    this.players.set(socketId, {
      id: socketId,
      name: name.slice(0, 20),
      ready: false,
      connected: true,
      hour: null,
      role: 'innocent', // 'thief' | 'assistant' | 'innocent'
      alive: true,
      hasRolled: false,
      hasActedThisHour: false,
    });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.votes.delete(socketId);
    if (this.hostId === socketId) {
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

  canStart() {
    return (
      this.phase === PHASES.LOBBY &&
      this.playerCount >= MIN_PLAYERS &&
      this.playerList.every((p) => p.ready)
    );
  }

  // Assign a random thief among current players
  assignThief() {
    const ids = this.playerList.map((p) => p.id);
    const thiefId = ids[Math.floor(Math.random() * ids.length)];
    this.thiefId = thiefId;
    this.players.get(thiefId).role = 'thief';
  }

  rollDiceFor(socketId) {
    const player = this.players.get(socketId);
    if (!player || player.hasRolled) return null;
    const hour = 1 + Math.floor(Math.random() * 6);
    player.hour = hour;
    player.hasRolled = true;
    return hour;
  }

  allPlayersRolled() {
    return this.playerList.every((p) => p.hasRolled);
  }

  playersAtHour(hour) {
    return this.playerList.filter((p) => p.hour === hour);
  }

  // Called when the Thief chooses their accomplice during their awake hour
  setAssistant(assistantId) {
    if (!this.players.has(assistantId)) return false;
    if (assistantId === this.thiefId) return false;
    this.assistantId = assistantId;
    this.players.get(assistantId).role = 'assistant';
    return true;
  }

  stealJewel(hour) {
    this.jewelStolen = true;
    this.stolenAtHour = hour;
  }

  addChatMessage(socketId, text) {
    const player = this.players.get(socketId);
    if (!player) return null;
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      playerId: socketId,
      name: player.name,
      text: String(text).slice(0, 400),
      ts: Date.now(),
    };
    this.chatMessages.push(msg);
    return msg;
  }

  castVote(voterId, targetId) {
    if (!this.players.has(voterId) || !this.players.has(targetId)) return false;
    this.votes.set(voterId, targetId);
    return true;
  }

  allVoted() {
    return this.votes.size === this.playerCount;
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
    const majorityThreshold = this.playerCount / 2;
    const isMajority = !tie && topCount > majorityThreshold;
    const innocentsWin = isMajority && topId === this.thiefId;
    return {
      counts: Object.fromEntries(counts),
      accusedId: tie ? null : topId,
      innocentsWin,
      tie,
    };
  }

  // Public-safe snapshot: strips secret role info unless `forId` is entitled to see it.
  publicState(forId = null) {
    const revealRoles = this.phase === PHASES.RESULTS;
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      jewelStolen: this.phase === PHASES.DAY || this.phase === PHASES.VOTING || this.phase === PHASES.RESULTS
        ? this.jewelStolen
        : false,
      currentHour: this.currentHour,
      phaseDeadline: this.phaseDeadline,
      players: this.playerList.map((p) => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        connected: p.connected,
        alive: p.alive,
        hour: this.phase === PHASES.LOBBY || this.phase === PHASES.ROLLING
          ? (p.id === forId ? p.hour : (p.hasRolled ? true : null)) // others only see "has rolled", not the number
          : p.hour, // hours become public once night starts (needed for deduction)
        role: revealRoles || p.id === forId ? p.role : undefined,
      })),
      voteCounts: this.phase === PHASES.RESULTS ? Object.fromEntries(this.votes.size ? this.tallyVotes().counts : []) : undefined,
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
};
