'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');
const answerKey = require('./answer-key');

const ROOM_CODE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 100;
const MAX_PLAYERS_PER_ROOM = 8;
const ROOM_TTL_MS = 30 * 60 * 1000;

function createMultiplayerServer({
  allowedOrigins = [],
  questionDurationMs = 25000,
  feedbackDurationMs = 2500,
  now = Date.now,
  random = Math.random
} = {}) {
  const rooms = new Map();
  const clients = new Set();
  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && requestPath === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (request.method === 'GET' && (requestPath === '/' || requestPath === '/index.html' || requestPath === '/answer-key.js')) {
      const isAnswerKey = requestPath === '/answer-key.js';
      const filePath = path.join(__dirname, isAnswerKey ? 'answer-key.js' : 'index.html');
      response.writeHead(200, {
        'Content-Type': isAnswerKey ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8'
      });
      fs.createReadStream(filePath).pipe(response);
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  const socketServer = new WebSocket.Server({
    server,
    path: '/ws',
    maxPayload: 4096,
    verifyClient: (info, done) => {
      const origin = info.origin;
      done(Boolean(origin && allowedOrigins.includes(origin)), 403, 'Origin not allowed');
    }
  });

  function send(socket, data) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  }

  function sendError(socket, message) {
    send(socket, { type: 'error', message });
  }

  function roomPlayers(room) {
    return Array.from(room.players.values()).map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      lives: player.lives,
      online: player.online,
      eliminated: player.lives === 0
    }));
  }

  function broadcast(room, message) {
    for (const player of room.players.values()) send(player.socket, message);
  }

  function broadcastLobby(room) {
    broadcast(room, {
      type: 'lobby_update',
      roomCode: room.code,
      hostId: room.hostId,
      phase: room.phase,
      players: roomPlayers(room)
    });
  }

  function broadcastStandings(room) {
    broadcast(room, {
      type: 'standings',
      players: roomPlayers(room)
    });
  }

  function clearRoomTimer(room) {
    if (room.timer !== null) {
      clearTimeout(room.timer);
      room.timer = null;
    }
  }

  function removeRoom(room) {
    clearRoomTimer(room);
    rooms.delete(room.code);
  }

  function clearExpiredRooms() {
    const cutoff = now() - ROOM_TTL_MS;
    for (const room of rooms.values()) {
      if (room.updatedAt < cutoff && room.phase !== 'playing') removeRoom(room);
    }
  }

  function createRoomCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let code = '';
      for (let index = 0; index < 6; index += 1) {
        code += ROOM_CODE_CHARACTERS[crypto.randomInt(ROOM_CODE_CHARACTERS.length)];
      }
      if (!rooms.has(code)) return code;
    }
    return null;
  }

  function validateName(value) {
    if (typeof value !== 'string') return null;
    const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return name.length > 0 && name.length <= 24 ? name : null;
  }

  function shuffle(items) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }

  function findPlayer(socket) {
    for (const room of rooms.values()) {
      for (const player of room.players.values()) {
        if (player.socket === socket) return { room, player };
      }
    }
    return null;
  }

  function enterRoom(socket, room, name, isHost) {
    const player = {
      id: crypto.randomUUID(),
      name,
      socket,
      online: true,
      score: 0,
      lives: 3,
      fiftyUsed: false,
      shieldUsed: false,
      shieldArmed: false,
      answered: false,
      answerResult: null
    };
    room.players.set(player.id, player);
    room.updatedAt = now();
    send(socket, {
      type: 'room_joined',
      roomCode: room.code,
      playerId: player.id,
      host: isHost,
      players: roomPlayers(room)
    });
    broadcastLobby(room);
  }

  function createRoom(socket, payload) {
    const name = validateName(payload.name);
    if (!name) {
      sendError(socket, 'Escribe un nombre de 1 a 24 caracteres.');
      return;
    }
    clearExpiredRooms();
    if (rooms.size >= MAX_ROOMS) {
      sendError(socket, 'En este momento no se pueden crear más salas. Inténtalo más tarde.');
      return;
    }
    const code = createRoomCode();
    if (!code) {
      sendError(socket, 'No se pudo generar un código de sala. Inténtalo de nuevo.');
      return;
    }
    const room = {
      code,
      hostId: null,
      players: new Map(),
      phase: 'lobby',
      questionOrder: [],
      current: 0,
      deadline: 0,
      timer: null,
      updatedAt: now()
    };
    rooms.set(code, room);
    const playerId = crypto.randomUUID();
    room.hostId = playerId;
    const player = {
      id: playerId,
      name,
      socket,
      online: true,
      score: 0,
      lives: 3,
      fiftyUsed: false,
      shieldUsed: false,
      shieldArmed: false,
      answered: false,
      answerResult: null
    };
    room.players.set(player.id, player);
    send(socket, {
      type: 'room_joined',
      roomCode: room.code,
      playerId: player.id,
      host: true,
      players: roomPlayers(room)
    });
    broadcastLobby(room);
  }

  function joinRoom(socket, payload) {
    const name = validateName(payload.name);
    const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
    if (!name) {
      sendError(socket, 'Escribe un nombre de 1 a 24 caracteres.');
      return;
    }
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      sendError(socket, 'El código debe tener seis caracteres.');
      return;
    }
    const room = rooms.get(code);
    if (!room || room.phase !== 'lobby') {
      sendError(socket, 'La sala no existe o ya comenzó la partida.');
      return;
    }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      sendError(socket, 'La sala está completa (máximo 8 participantes).');
      return;
    }
    if (Array.from(room.players.values()).some(player => player.name.toLowerCase() === name.toLowerCase())) {
      sendError(socket, 'Ese nombre ya está en uso en la sala.');
      return;
    }
    enterRoom(socket, room, name, false);
  }

  function sendQuestion(room, player) {
    const questionIndex = room.questionOrder[room.current];
    player.answered = player.lives === 0 || !player.online;
    player.answerResult = null;
    player.shieldArmed = false;
    send(player.socket, {
      type: 'question',
      questionIndex,
      current: room.current,
      total: answerKey.length,
      deadline: room.deadline,
      score: player.score,
      lives: player.lives,
      eliminated: player.lives === 0,
      fiftyUsed: player.fiftyUsed,
      shieldUsed: player.shieldUsed,
      players: roomPlayers(room)
    });
  }

  function allPlayersDone(room) {
    return Array.from(room.players.values()).every(player =>
      player.answered || player.lives === 0 || !player.online
    );
  }

  function finishRound(room) {
    if (room.phase !== 'playing') return;
    clearRoomTimer(room);
    room.phase = 'round-feedback';
    const questionIndex = room.questionOrder[room.current];
    broadcast(room, {
      type: 'round_reveal',
      questionIndex,
      correctOption: answerKey[questionIndex],
      current: room.current,
      total: answerKey.length
    });
    broadcastStandings(room);
    room.updatedAt = now();
    room.timer = setTimeout(() => {
      room.timer = null;
      if (room.current === room.questionOrder.length - 1) {
        room.phase = 'finished';
        const players = roomPlayers(room).sort((a, b) => b.score - a.score || b.lives - a.lives);
        broadcast(room, { type: 'game_over', players });
        room.updatedAt = now();
        return;
      }
      room.current += 1;
      room.phase = 'playing';
      room.deadline = now() + questionDurationMs;
      for (const player of room.players.values()) sendQuestion(room, player);
      room.timer = setTimeout(() => expireRound(room), questionDurationMs);
    }, feedbackDurationMs);
  }

  function expireRound(room) {
    if (room.phase !== 'playing') return;
    clearRoomTimer(room);
    const questionIndex = room.questionOrder[room.current];
    for (const player of room.players.values()) {
      if (player.answered || player.lives === 0 || !player.online) continue;
      player.answered = true;
      player.lives -= 1;
      if (player.lives === 0) player.shieldArmed = false;
      player.answerResult = { correct: false, shieldSaved: false, timeout: true };
      send(player.socket, {
        type: 'answer_result',
        ...player.answerResult,
        correctOption: answerKey[questionIndex],
        score: player.score,
        lives: player.lives
      });
    }
    finishRound(room);
  }

  function startGame(room) {
    room.phase = 'playing';
    room.questionOrder = shuffle(answerKey.map((_, index) => index));
    room.current = 0;
    room.deadline = now() + questionDurationMs;
    for (const player of room.players.values()) sendQuestion(room, player);
    room.timer = setTimeout(() => expireRound(room), questionDurationMs);
  }

  function answerQuestion(room, player, payload) {
    if (room.phase !== 'playing' || player.answered || player.lives === 0) return;
    if (!Number.isInteger(payload.selected) || payload.selected < 0 || payload.selected > 3) {
      sendError(player.socket, 'Selecciona una de las cuatro opciones.');
      return;
    }
    if (now() >= room.deadline) {
      expireRound(room);
      return;
    }
    player.answered = true;
    const questionIndex = room.questionOrder[room.current];
    const correct = payload.selected === answerKey[questionIndex];
    const shieldSaved = !correct && player.shieldArmed && !player.shieldUsed;
    if (correct) {
      player.score += 2;
      player.shieldArmed = false;
    } else if (shieldSaved) {
      player.shieldUsed = true;
      player.shieldArmed = false;
    } else {
      player.lives -= 1;
      player.shieldArmed = false;
    }
    player.answerResult = { correct, shieldSaved, timeout: false };
    send(player.socket, {
      type: 'answer_result',
      ...player.answerResult,
      selected: payload.selected,
      correctOption: answerKey[questionIndex],
      score: player.score,
      lives: player.lives
    });
    broadcastStandings(room);
    if (allPlayersDone(room)) finishRound(room);
  }

  function useLifeline(room, player, payload) {
    if (room.phase !== 'playing' || player.answered || player.lives === 0) return;
    const questionIndex = room.questionOrder[room.current];
    if (payload.name === 'fifty') {
      if (player.fiftyUsed) {
        sendError(player.socket, 'Ya utilizaste el comodín 50/50.');
        return;
      }
      player.fiftyUsed = true;
      const incorrect = shuffle([0, 1, 2, 3].filter(index => index !== answerKey[questionIndex]));
      send(player.socket, { type: 'lifeline_result', name: 'fifty', removedOptions: incorrect.slice(0, 2) });
      return;
    }
    if (payload.name === 'shield') {
      if (player.shieldUsed) {
        sendError(player.socket, 'Ya utilizaste el escudo.');
        return;
      }
      player.shieldArmed = !player.shieldArmed;
      send(player.socket, { type: 'lifeline_result', name: 'shield', armed: player.shieldArmed });
      return;
    }
    sendError(player.socket, 'Comodín desconocido.');
  }

  function leaveRoom(socket, player, room) {
    room.players.delete(player.id);
    player.online = false;
    if (room.players.size === 0) {
      removeRoom(room);
      socket.close(1000, 'Left room');
      return;
    }
    if (room.hostId === player.id && room.phase === 'lobby') {
      room.hostId = room.players.keys().next().value;
    }
    if (room.phase === 'playing') {
      player.answered = true;
      if (allPlayersDone(room)) finishRound(room);
    } else {
      room.updatedAt = now();
    }
    broadcastLobby(room);
    if (room.phase === 'finished' && room.players.size === 0) removeRoom(room);
    socket.close(1000, 'Left room');
  }

  function handleMessage(socket, rawMessage) {
    let payload;
    try {
      payload = JSON.parse(rawMessage.toString());
    } catch (error) {
      sendError(socket, 'El mensaje no tiene un formato válido.');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.type !== 'string') {
      sendError(socket, 'El mensaje no tiene un formato válido.');
      return;
    }

    const existing = findPlayer(socket);
    if (payload.type === 'create') {
      if (existing) return sendError(socket, 'Ya estás dentro de una sala.');
      return createRoom(socket, payload);
    }
    if (payload.type === 'join') {
      if (existing) return sendError(socket, 'Ya estás dentro de una sala.');
      return joinRoom(socket, payload);
    }
    if (!existing) return sendError(socket, 'Primero crea o únete a una sala.');

    const { room, player } = existing;
    if (payload.type === 'leave') return leaveRoom(socket, player, room);
    if (payload.type === 'start') {
      if (room.phase !== 'lobby' || player.id !== room.hostId) {
        return sendError(socket, 'Solo quien creó la sala puede iniciar la partida.');
      }
      if (Array.from(room.players.values()).filter(member => member.online).length < 2) {
        return sendError(socket, 'Se necesitan al menos dos participantes conectados.');
      }
      startGame(room);
      return;
    }
    if (payload.type === 'answer') return answerQuestion(room, player, payload);
    if (payload.type === 'lifeline') return useLifeline(room, player, payload);
    sendError(socket, 'Acción desconocida.');
  }

  socketServer.on('connection', socket => {
    clients.add(socket);
    socket.on('message', message => handleMessage(socket, message));
    socket.on('close', () => {
      clients.delete(socket);
      const existing = findPlayer(socket);
      if (!existing) return;
      const { room, player } = existing;
      if (room.phase === 'lobby') {
        room.players.delete(player.id);
        if (room.players.size === 0) {
          removeRoom(room);
          return;
        }
        if (room.hostId === player.id) room.hostId = room.players.keys().next().value;
        room.updatedAt = now();
        broadcastLobby(room);
        return;
      }
      player.online = false;
      player.answered = true;
      room.updatedAt = now();
      if (!Array.from(room.players.values()).some(member => member.online)) removeRoom(room);
      else if (room.phase === 'playing' && allPlayersDone(room)) finishRound(room);
      else if (room.phase === 'playing') broadcastStandings(room);
    });
    socket.on('error', error => console.error('WebSocket client error:', error.message));
  });

  function close(callback) {
    for (const room of rooms.values()) clearRoomTimer(room);
    for (const socket of clients) socket.close();
    socketServer.close();
    server.close(callback);
  }

  return { server, close };
}

if (require.main === module) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) {
    allowedOrigins.push(
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    );
  }
  const { server } = createMultiplayerServer({ allowedOrigins });
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`Session Lab multiplayer listening on port ${port}`);
  });
}

module.exports = { createMultiplayerServer };
