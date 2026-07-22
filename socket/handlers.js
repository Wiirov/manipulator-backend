import { customAlphabet } from 'nanoid';
import { Room, PHASES, CONFIG } from '../game/Room.js';
import {
  startRollingPhase,
  maybeStartNight,
  handleThiefAction,
  maybeFinishVotingEarly,
  resetRoomToLobby,
  broadcastRoom,
} from '../game/gameLogic.js';

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);
const sessions = new Map();
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = nanoid();
  } while (rooms.has(code));
  return code;
}

function createPlayerId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getRoomOfSocket(socket) {
  const playerId = socket.data.playerId;
  if (playerId) {
    for (const room of rooms.values()) {
      if (room.players.has(playerId)) return room;
    }
  }
  return null;
}

function getPlayerForSocket(socket) {
  const room = getRoomOfSocket(socket);
  if (!room) return null;
  return room.players.get(socket.data.playerId);
}

export function registerSocketHandlers(io, socket) {
  socket.on('create_room', ({ name, isSpectator }, cb) => {
    if (!name || !name.trim()) return cb?.({ error: 'Name required' });
    const code = generateRoomCode();
    const room = new Room(code, null);
    const playerId = createPlayerId();
    room.addPlayer(playerId, name.trim(), { socketId: socket.id, isSpectator: Boolean(isSpectator) });
    room.hostId = playerId;
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    const sessionId = createSessionId();
    sessions.set(sessionId, { id: sessionId, roomCode: code, playerId, socketId: socket.id, name: name.trim(), isSpectator: Boolean(isSpectator) });
    cb?.({ ok: true, code, sessionId, playerId });
    broadcastRoom(io, room);
  });

  socket.on('join_room', ({ code, name, isSpectator }, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.phase !== PHASES.LOBBY) return cb?.({ error: 'Game already in progress' });
    if (!name || !name.trim()) return cb?.({ error: 'Name required' });

    const playerId = createPlayerId();
    room.addPlayer(playerId, name.trim(), { socketId: socket.id, isSpectator: Boolean(isSpectator) });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    const sessionId = createSessionId();
    sessions.set(sessionId, { id: sessionId, roomCode: room.code, playerId, socketId: socket.id, name: name.trim(), isSpectator: Boolean(isSpectator) });
    cb?.({ ok: true, code: room.code, sessionId, playerId });
    broadcastRoom(io, room);
  });

  socket.on('restore_session', ({ sessionId, roomId, playerId }, cb) => {
    const session = sessions.get(sessionId);
    const room = rooms.get((roomId || '').toUpperCase());
    if (!session || !room || session.roomCode !== room.code || session.playerId !== playerId) {
      return cb?.({ error: 'Session expired' });
    }

    const existingPlayer = room.players.get(playerId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.connected = true;
    } else {
      room.addPlayer(playerId, session.name, { socketId: socket.id, isSpectator: Boolean(session.isSpectator) });
    }

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    session.socketId = socket.id;
    cb?.({ ok: true, code: room.code, sessionId, playerId });
    broadcastRoom(io, room);
  });

  socket.on('update_room_settings', ({ settings }, cb) => {
    const room = getRoomOfSocket(socket);
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.hostId !== socket.data.playerId) return cb?.({ error: 'Only the host can change settings' });
    room.updateSettings(settings);
    cb?.({ ok: true, settings: room.settings });
    broadcastRoom(io, room);
  });

  socket.on('toggle_ready', () => {
    const room = getRoomOfSocket(socket);
    if (!room || room.phase !== PHASES.LOBBY) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || player.isSpectator) return;
    player.ready = !player.ready;
    broadcastRoom(io, room);
  });

  socket.on('start_game', () => {
    const room = getRoomOfSocket(socket);
    if (!room) return;
    if (room.hostId !== socket.data.playerId) return;
    if (!room.canStart()) {
      socket.emit('error_message', {
        message: `Need at least ${CONFIG.MIN_PLAYERS} active players, all ready.`,
      });
      return;
    }
    startRollingPhase(io, room);
  });

  socket.on('roll_dice', () => {
    const room = getRoomOfSocket(socket);
    if (!room || room.phase !== PHASES.ROLLING) return;
    const hour = room.rollDiceFor(socket.data.playerId);
    if (hour === null) return;
    socket.emit('dice_result', { hour });
    broadcastRoom(io, room);
    maybeStartNight(io, room);
  });

  socket.on('thief_steal', ({ assistantId }) => {
    const room = getRoomOfSocket(socket);
    if (!room) return;
    handleThiefAction(io, room, socket.data.playerId, assistantId || null);
  });

  socket.on('chat_message', ({ text }) => {
    const room = getRoomOfSocket(socket);
    if (!room || room.phase !== PHASES.DAY) return;
    if (!text || !text.trim()) return;
    const msg = room.addChatMessage(socket.data.playerId, text.trim());
    if (msg) io.to(room.code).emit('chat_message', msg);
  });

  socket.on('cast_vote', ({ targetId }) => {
    const room = getRoomOfSocket(socket);
    if (!room || room.phase !== PHASES.VOTING) return;
    const ok = room.castVote(socket.data.playerId, targetId);
    if (!ok) return;
    io.to(room.code).emit('vote_cast', { voterId: socket.data.playerId, voteCount: room.votes.size, total: room.activePlayerCount });
    maybeFinishVotingEarly(io, room);
  });

  socket.on('play_again', () => {
    const room = getRoomOfSocket(socket);
    if (!room || room.hostId !== socket.data.playerId) return;
    resetRoomToLobby(io, room);
  });

  socket.on('disconnect', () => {
    const playerId = socket.data.playerId;
    const room = getRoomOfSocket(socket);
    if (!room || !playerId) return;

    const player = room.players.get(playerId);
    if (player) {
      player.connected = false;
      player.socketId = null;
    }
    broadcastRoom(io, room);
  });
}
