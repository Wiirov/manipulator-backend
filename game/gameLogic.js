// gameLogic.js — orchestrates phase transitions that involve server-driven timers
// (the night hour sequence, day discussion countdown, voting countdown).
// Everything here is triggered from socket/handlers.js and pushes state via `io`.

import { PHASES, CONFIG } from './Room.js';

function broadcastRoom(io, room) {
  for (const player of room.playerList) {
    io.to(player.id).emit('room_update', room.publicState(player.id));
  }
}

export function startRollingPhase(io, room) {
  room.phase = PHASES.ROLLING;
  room.assignThief();
  broadcastRoom(io, room);
}

// Called whenever a roll comes in; once everyone has rolled, kick off the night.
export function maybeStartNight(io, room) {
  if (!room.allPlayersRolled()) return;
  room.phase = PHASES.NIGHT;
  room.currentHour = 0;
  room.jewelStolen = false;
  room.stolenAtHour = null;
  broadcastRoom(io, room);
  advanceNightHour(io, room);
}

function advanceNightHour(io, room) {
  room.currentHour += 1;

  if (room.currentHour > 6) {
    endNightPhase(io, room);
    return;
  }

  const awakePlayers = room.playersAtHour(room.currentHour);
  room.phaseDeadline = Date.now() + CONFIG.NIGHT_HOUR_DURATION_MS;

  // Public tick so everyone's UI shows "Hour N" and the sleeping animation
  broadcastRoom(io, room);

  // Private payload only to players awake this hour
  for (const player of awakePlayers) {
    const isThief = player.id === room.thiefId;
    io.to(player.id).emit('night_wake', {
      hour: room.currentHour,
      isThief,
      jewelPresent: !room.jewelStolen,
      // thief gets the roster (minus self) to pick an assistant from
      candidates: isThief
        ? room.playerList.filter((p) => p.id !== room.thiefId).map((p) => ({ id: p.id, name: p.name }))
        : undefined,
    });
  }

  room.resetTimers();
  room.nightTimer = setTimeout(() => {
    advanceNightHour(io, room);
  }, CONFIG.NIGHT_HOUR_DURATION_MS);
}

// Thief calls this (via socket handler) during their awake window.
export function handleThiefAction(io, room, thiefSocketId, assistantId) {
  if (room.phase !== PHASES.NIGHT) return;
  if (thiefSocketId !== room.thiefId) return;
  const currentHourPlayers = room.playersAtHour(room.currentHour).map((p) => p.id);
  if (!currentHourPlayers.includes(thiefSocketId)) return; // not their hour

  room.stealJewel(room.currentHour);
  if (assistantId) {
    room.setAssistant(assistantId);
  }

  io.to(thiefSocketId).emit('theft_confirmed', {
    assistantId: room.assistantId,
  });
}

function endNightPhase(io, room) {
  room.resetTimers();
  room.phase = PHASES.DAY;
  room.phaseDeadline = Date.now() + CONFIG.DAY_DISCUSSION_MS;
  broadcastRoom(io, room);

  room.nightTimer = setTimeout(() => {
    startVotingPhase(io, room);
  }, CONFIG.DAY_DISCUSSION_MS);
}

export function startVotingPhase(io, room) {
  room.resetTimers();
  room.phase = PHASES.VOTING;
  room.votes.clear();
  room.phaseDeadline = Date.now() + CONFIG.VOTING_DURATION_MS;
  broadcastRoom(io, room);

  room.nightTimer = setTimeout(() => {
    finishVoting(io, room);
  }, CONFIG.VOTING_DURATION_MS);
}

export function maybeFinishVotingEarly(io, room) {
  if (room.phase !== PHASES.VOTING) return;
  if (room.allVoted()) {
    finishVoting(io, room);
  }
}

function finishVoting(io, room) {
  room.resetTimers();
  room.phase = PHASES.RESULTS;
  const result = room.tallyVotes();

  for (const player of room.playerList) {
    io.to(player.id).emit('game_result', {
      ...result,
      thiefId: room.thiefId,
      assistantId: room.assistantId,
      stolenAtHour: room.stolenAtHour,
      players: room.playerList.map((p) => ({ id: p.id, name: p.name, role: p.role, hour: p.hour })),
    });
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
  for (const p of room.playerList) {
    p.ready = false;
    p.hour = null;
    p.role = 'innocent';
    p.hasRolled = false;
  }
  broadcastRoom(io, room);
}

export { broadcastRoom };
