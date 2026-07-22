// gameLogic.js — orchestrates phase transitions that involve server-driven timers
// (the night hour sequence, day discussion countdown, voting countdown).
// Everything here is triggered from socket/handlers.js and pushes state via `io`.

import { PHASES, CONFIG } from './Room.js';

function broadcastRoom(io, room) {
  for (const player of room.playerList) {
    if (player.socketId) {
      io.to(player.socketId).emit('room_update', room.publicState(player.id));
    }
  }
}

function emitToAll(io, room, eventName, payload) {
  for (const player of room.playerList) {
    if (player.socketId) {
      io.to(player.socketId).emit(eventName, payload);
    }
  }
}

export function startRollingPhase(io, room) {
  room.phase = PHASES.ROLLING;
  room.assignRoles();
  room.tieBreaker = null;
  broadcastRoom(io, room);
  emitToAll(io, room, 'game_started', {});
  for (const player of room.playerList) {
    if (player.socketId) {
      io.to(player.socketId).emit('role_assigned', {
        playerId: player.id,
        role: player.role,
        isThief: player.role === 'thief',
      });
    }
  }
  for (const player of room.playerList) {
    if (!player.socketId) continue;
    if (player.role === 'thief') {
      io.to(player.socketId).emit('thief_role_intro', {
        title: 'You are the Thief',
        message: 'The city never learns your name. Choose your moment — and your accomplice — wisely.',
      });
    } else {
      io.to(player.socketId).emit('game_start_intro', {
        title: 'The Match Begins',
        message: 'The city sleeps and the jewel waits.',
      });
    }
  }
}

// Called whenever a roll comes in; once everyone has rolled, kick off the night.
export function maybeStartNight(io, room) {
  if (!room.allPlayersRolled()) return;
  room.phase = PHASES.NIGHT;
  room.currentHour = 0;
  room.jewelStolen = false;
  room.stolenAtHour = null;
  room.phaseDeadline = Date.now() + room.settings.nightHourDurationMs;
  broadcastRoom(io, room);
  advanceNightHour(io, room);
}

function recordJewelObservation(player, room) {
  player.jewelObservationAtHour = room.jewelStolen ? 'gone' : 'present';
}

function finalizeHourObservations(room, hour) {
  for (const player of room.playersAtHour(hour)) {
    if (player.jewelObservationAtHour != null) continue;
    player.jewelObservationAtHour = room.jewelStolen ? 'gone' : 'present';
  }
}

function advanceNightHour(io, room) {
  room.currentHour += 1;

  if (room.currentHour > room.settings.maxHours) {
    finalizeHourObservations(room, room.currentHour - 1);
    endNightPhase(io, room);
    return;
  }

  const awakePlayers = room.playersAtHour(room.currentHour);
  room.phaseDeadline = Date.now() + room.settings.nightHourDurationMs;
  emitToAll(io, room, 'night_hour', { hour: room.currentHour });
  broadcastRoom(io, room);

  for (const player of awakePlayers) {
    const isThief = player.id === room.thiefId;
    const jewelPresent = !room.jewelStolen;
    recordJewelObservation(player, room);
    const coAwakePlayers = awakePlayers
      .filter((candidate) => candidate.id !== player.id)
      .map((candidate) => ({ id: candidate.id, name: candidate.name }));
    const revealedThief = awakePlayers.find((candidate) => candidate.role === 'thief');
    io.to(player.socketId).emit('night_wake', {
      hour: room.currentHour,
      isThief,
      jewelPresent,
      coAwakePlayers,
      revealedThief: revealedThief && !isThief ? { id: revealedThief.id, name: revealedThief.name } : null,
      candidates: isThief
        ? room.activePlayers
            .filter((p) => p.id !== room.thiefId && p.role === 'innocent')
            .map((p) => ({ id: p.id, name: p.name }))
        : undefined,
    });
  }

  room.resetTimers();
  room.nightTimer = setTimeout(() => {
    finalizeHourObservations(room, room.currentHour);
    advanceNightHour(io, room);
  }, room.settings.nightHourDurationMs);
}

// Thief calls this (via socket handler) during their awake window.
export function handleThiefAction(io, room, thiefPlayerId, assistantId) {
  if (room.phase !== PHASES.NIGHT) return;
  if (thiefPlayerId !== room.thiefId) return;
  const currentHourPlayers = room.playersAtHour(room.currentHour).map((p) => p.id);
  if (!currentHourPlayers.includes(thiefPlayerId)) return;

  if (room.jewelStolen) return;

  if (!assistantId) return;
  if (!room.setAssistant(assistantId)) return;

  room.stealJewel(room.currentHour);

  const thiefPlayer = room.players.get(thiefPlayerId);
  thiefPlayer.jewelObservationAtHour = 'gone';
  io.to(thiefPlayer.socketId).emit('theft_confirmed', {
    assistantId: room.assistantId,
  });

  const assistantPlayer = room.players.get(room.assistantId);
  if (assistantPlayer?.socketId) {
    io.to(assistantPlayer.socketId).emit('assistant_selected_intro', {
      title: 'You Are In',
      subtitle: 'Accomplice',
      message: `${thiefPlayer.name} chose you as their accomplice.`,
      detail: 'You now wake with the Thief. Help them stay hidden — the table must never find out.',
    });
    io.to(assistantPlayer.socketId).emit('role_assigned', {
      playerId: assistantPlayer.id,
      role: 'assistant',
      isThief: false,
    });
  }

  broadcastRoom(io, room);
}

function endNightPhase(io, room) {
  room.resetTimers();
  room.phase = PHASES.DAY;
  room.phaseDeadline = Date.now() + room.settings.discussionDurationMs;
  emitToAll(io, room, 'discussion_started', {});
  broadcastRoom(io, room);

  room.nightTimer = setTimeout(() => {
    startVotingPhase(io, room);
  }, room.settings.discussionDurationMs);
}

export function startVotingPhase(io, room) {
  room.resetTimers();
  room.phase = PHASES.VOTING;
  room.votes.clear();
  room.tieBreaker = null;
  room.phaseDeadline = Date.now() + room.settings.votingDurationMs;
  broadcastRoom(io, room);

  room.nightTimer = setTimeout(() => {
    finishVoting(io, room);
  }, room.settings.votingDurationMs);
}

export function maybeFinishVotingEarly(io, room) {
  if (room.phase !== PHASES.VOTING) return;
  if (room.allVoted()) {
    finishVoting(io, room);
  }
}

function finishVoting(io, room) {
  room.resetTimers();
  const result = room.tallyVotes();
  if (result.tie && result.tieBreakerCandidates.length) {
    room.phase = PHASES.VOTING;
    room.startTieBreaker();
    room.phaseDeadline = Date.now() + room.settings.tieBreakerDurationMs;
    broadcastRoom(io, room);
    room.nightTimer = setTimeout(() => {
      finishVoting(io, room);
    }, room.settings.tieBreakerDurationMs);
    return;
  }

  room.phase = PHASES.RESULTS;
  room.phaseDeadline = null;
  emitToAll(io, room, 'vote_results', { winner: result.winner });
  for (const player of room.playerList) {
    if (player.socketId) {
      io.to(player.socketId).emit('game_result', {
        ...result,
        thiefId: room.thiefId,
        assistantId: room.assistantId,
        stolenAtHour: room.stolenAtHour,
        players: room.playerList.map((p) => ({ id: p.id, name: p.name, role: p.role, hour: p.hour, isSpectator: p.isSpectator })),
      });
    }
  }
  broadcastRoom(io, room);
}

export function resetRoomToLobby(io, room) {
  room.resetTimers();
  room.phase = PHASES.LOBBY;
  room.jewelStolen = false;
  room.stolenAtHour = null;
  room.thiefId = null;
  room.assistantId = null;
  room.currentHour = 0;
  room.chatMessages = [];
  room.votes.clear();
  room.tieBreaker = null;
  for (const p of room.playerList) {
    p.ready = false;
    p.hour = null;
    p.role = p.isSpectator ? 'spectator' : 'innocent';
    p.hasRolled = false;
    p.jewelObservationAtHour = null;
  }
  broadcastRoom(io, room);
}

export { broadcastRoom };
