import { customAlphabet } from 'nanoid';
import { Room, PHASES, CONFIG } from '../game/Room.js';
import {
  startRollingPhase,
  maybeStartNight,
  handleThiefAction,
  startVotingPhase,
  maybeFinishVotingEarly,
  resetRoomToLobby,
  broadcastRoom,
} from '../game/gameLogic.js';

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);

// In-memory room store. Fine for a single-process game server;
// swap for Redis if you ever need horizontal scaling.
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = nanoid();
  } while (rooms.has(code));
  return code;
}

function getRoomOfSocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

export function registerSocketHandlers(io, socket) {
  socket.on('create_room', ({ name }, cb) => {
    if (!name || !name.trim()) return cb?.({ error: 'Name required' });
    const code = generateRoomCode();
    const room = new Room(code, socket.id);
    room.addPlayer(socket.id, name.trim());
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb?.({ ok: true, code });
    broadcastRoom(io, room);
  });

  socket.on('join_room', ({ code, name }, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.phase !== PHASES.LOBBY) return cb?.({ error: 'Game already in progress' });
    if (room.playerCount >= 12) return cb?.({ error: 'Room is full' });
    if (!name || !name.trim()) return cb?.({ error: 'Name required' });

    room.addPlayer(socket.id, name.trim());
    socket.join(room.code);
    socket.data.roomCode = room.code;
    cb?.({ ok: true, code: room.code });
    broadcastRoom(io, room);
  });

  socket.on('toggle_ready', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.phase !== PHASES.LOBBY) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.ready = !player.ready;
    broadcastRoom(io, room);
  });

  socket.on('start_game', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (!room.canStart()) {
      socket.emit('error_message', {
        message: `Need at least ${CONFIG.MIN_PLAYERS} players, all ready.`,
      });
      return;
    }
    startRollingPhase(io, room);
  });

  socket.on('roll_dice', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.phase !== PHASES.ROLLING) return;
    const hour = room.rollDiceFor(socket.id);
    if (hour === null) return;
    socket.emit('dice_result', { hour });
    broadcastRoom(io, room);
    maybeStartNight(io, room);
  });

  socket.on('thief_steal', ({ assistantId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;
    handleThiefAction(io, room, socket.id, assistantId || null);
  });

  socket.on('chat_message', ({ text }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.phase !== PHASES.DAY) return;
    if (!text || !text.trim()) return;
    const msg = room.addChatMessage(socket.id, text.trim());
    if (msg) io.to(room.code).emit('chat_message', msg);
  });

  socket.on('cast_vote', ({ targetId }) => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.phase !== PHASES.VOTING) return;
    const ok = room.castVote(socket.id, targetId);
    if (!ok) return;
    io.to(room.code).emit('vote_cast', { voterId: socket.id, voteCount: room.votes.size, total: room.playerCount });
    maybeFinishVotingEarly(io, room);
  });

  socket.on('play_again', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    resetRoomToLobby(io, room);
  });

  socket.on('disconnect', () => {
    const room = getRoomOfSocket(socket.id);
    if (!room) return;

    if (room.phase === PHASES.LOBBY) {
      room.removePlayer(socket.id);
      if (room.playerCount === 0) {
        rooms.delete(room.code);
        return;
      }
    } else {
      // Mid-game: keep their seat (role/hour intact) but mark disconnected
      // so votes/deduction still make sense; they can rejoin logic could be
      // added later via a reconnect token.
      const p = room.players.get(socket.id);
      if (p) p.connected = false;
    }
    broadcastRoom(io, room);
  });
}
