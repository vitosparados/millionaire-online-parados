'use strict';

try { require('dotenv').config(); } catch (e) { /* dotenv optional in prod */ }

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const userStore = require('./lib/userStore');
const { signToken, verifyToken } = require('./lib/auth');
const {
  topicList, buildQuestionSet, LADDER, CHECKPOINTS, safeMoney,
} = require('./lib/questions');

const PORT = process.env.PORT || 3000;
const QUESTION_SECONDS = 25;
const REVEAL_DELAY_MS = 3500;
const MAX_PLAYERS = 5;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов (0/O, 1/I)

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
   REST: регистрация / вход
========================================================= */
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const result = userStore.registerUser(username, password);
  if (result.error) return res.status(400).json({ error: result.error });
  const token = signToken(result.user.username);
  res.json({ token, username: result.user.username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = userStore.verifyUser(username, password);
  if (result.error) return res.status(401).json({ error: result.error });
  const token = signToken(result.user.username);
  res.json({ token, username: result.user.username });
});

app.get('/api/me', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const username = token && verifyToken(token);
  if (!username) return res.status(401).json({ error: 'Не авторизован' });
  const user = userStore.getUser(username);
  if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
  res.json({ username: user.username, stats: user.stats });
});

app.get('/api/topics', (req, res) => {
  res.json({ topics: topicList() });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* =========================================================
   Socket.io auth middleware — проверяем JWT при подключении
========================================================= */
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const username = token && verifyToken(token);
  if (!username) return next(new Error('unauthorized'));
  socket.data.username = username;
  next();
});

/* =========================================================
   Игровое состояние в памяти
   rooms: code -> room
   userRoom: username -> code  (для восстановления сессии при переподключении)
========================================================= */
const rooms = new Map();
const userRoom = new Map();

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function publicPlayerList(room) {
  return Array.from(room.players.values()).map(p => ({
    username: p.username,
    connected: p.connected,
    isHost: p.username === room.hostUsername,
    level: p.level,
    alive: p.alive,
    bankedMoney: p.bankedMoney,
    finishedReason: p.finishedReason || null,
  }));
}

function broadcastPlayers(room) {
  io.to(room.code).emit('room:players', {
    code: room.code,
    status: room.status,
    topic: room.topic,
    hostUsername: room.hostUsername,
    players: publicPlayerList(room),
  });
}

function alivePlayers(room) {
  return Array.from(room.players.values()).filter(p => p.alive && p.connected);
}

function destroyRoomIfEmpty(room) {
  const anyone = Array.from(room.players.values()).some(p => p.connected);
  if (!anyone) {
    if (room.timer) clearTimeout(room.timer);
    rooms.delete(room.code);
  }
}

function sendQuestionToRoom(room) {
  const q = room.questions[room.currentIndex];
  room.answers = new Map();
  room.questionStartedAt = Date.now();

  const payload = {
    index: room.currentIndex,
    total: room.questions.length,
    text: q.q,
    options: q.options,
    prize: LADDER[room.currentIndex],
    isCheckpoint: CHECKPOINTS.includes(room.currentIndex + 1),
    durationSeconds: QUESTION_SECONDS,
    startedAt: room.questionStartedAt,
  };

  alivePlayers(room).forEach(p => {
    io.to(p.socketId).emit('game:question', payload);
  });
  // наблюдателям (выбывшим/офлайн) тоже показываем вопрос, но без права отвечать
  Array.from(room.players.values()).filter(p => !p.alive && p.connected).forEach(p => {
    io.to(p.socketId).emit('game:question', { ...payload, spectateOnly: true });
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => revealRound(room), QUESTION_SECONDS * 1000 + 300);
}

function revealRound(room) {
  if (room.status !== 'playing') return;
  clearTimeout(room.timer);
  const q = room.questions[room.currentIndex];

  const results = [];
  room.players.forEach(p => {
    if (!p.alive) return;
    const chosen = room.answers.get(p.username);
    const correct = chosen === q.correctIndex;
    if (correct) {
      p.level += 1;
      if (p.level >= room.questions.length) {
        p.alive = false;
        p.finishedReason = 'won';
        p.bankedMoney = LADDER[room.questions.length - 1];
      }
    } else {
      p.alive = false;
      p.finishedReason = 'wrong';
      p.bankedMoney = safeMoney(p.level);
    }
    results.push({
      username: p.username,
      chosen: chosen === undefined ? null : chosen,
      correct,
      level: p.level,
      alive: p.alive,
      bankedMoney: p.bankedMoney,
    });
  });

  io.to(room.code).emit('game:reveal', {
    correctIndex: q.correctIndex,
    results,
  });

  const anyoneStillAlive = alivePlayers(room).length > 0;
  const questionsLeft = room.currentIndex + 1 < room.questions.length;

  room.timer = setTimeout(() => {
    if (anyoneStillAlive && questionsLeft) {
      room.currentIndex += 1;
      sendQuestionToRoom(room);
    } else {
      finishGame(room);
    }
  }, REVEAL_DELAY_MS);
}

function finishGame(room) {
  room.status = 'finished';
  const standings = Array.from(room.players.values())
    .map(p => ({ username: p.username, bankedMoney: p.bankedMoney, finishedReason: p.finishedReason }))
    .sort((a, b) => b.bankedMoney - a.bankedMoney);

  standings.forEach(s => userStore.recordResult(s.username, s.bankedMoney));

  io.to(room.code).emit('game:over', { standings });
  broadcastPlayers(room);
}

/* =========================================================
   SOCKET EVENTS
========================================================= */
io.on('connection', (socket) => {
  const username = socket.data.username;

  // Автовосстановление сессии: если пользователь уже был в комнате — переподключаем сокет
  const existingCode = userRoom.get(username);
  if (existingCode && rooms.has(existingCode)) {
    const room = rooms.get(existingCode);
    const player = room.players.get(username);
    if (player) {
      player.socketId = socket.id;
      player.connected = true;
      socket.join(room.code);
      socket.emit('room:rejoined', {
        code: room.code, status: room.status, topic: room.topic, hostUsername: room.hostUsername,
      });
      broadcastPlayers(room);
      if (room.status === 'playing') {
        const q = room.questions[room.currentIndex];
        socket.emit('game:question', {
          index: room.currentIndex,
          total: room.questions.length,
          text: q.q,
          options: q.options,
          prize: LADDER[room.currentIndex],
          isCheckpoint: CHECKPOINTS.includes(room.currentIndex + 1),
          durationSeconds: QUESTION_SECONDS,
          startedAt: room.questionStartedAt,
          spectateOnly: !player.alive,
        });
      }
    }
  }

  socket.emit('hello', { username });

  socket.on('room:create', ({ topic }) => {
    if (userRoom.get(username) && rooms.has(userRoom.get(username))) {
      return socket.emit('room:error', { message: 'Вы уже находитесь в комнате' });
    }
    const code = makeRoomCode();
    const room = {
      code,
      hostUsername: username,
      topic: topic && topicList().some(t => t.key === topic) ? topic : (topic === 'mix' ? 'mix' : 'general'),
      status: 'lobby',
      players: new Map(),
      questions: [],
      currentIndex: 0,
      answers: new Map(),
      timer: null,
      questionStartedAt: 0,
    };
    room.players.set(username, {
      username, socketId: socket.id, connected: true,
      level: 0, alive: true, bankedMoney: 0, finishedReason: null,
      lifelines: { fifty: true, audience: true, expert: true },
    });
    rooms.set(code, room);
    userRoom.set(username, code);
    socket.join(code);
    socket.emit('room:created', { code, topic: room.topic });
    broadcastPlayers(room);
  });

  socket.on('room:join', ({ code }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return socket.emit('room:error', { message: 'Комната не найдена' });
    if (room.status !== 'lobby') return socket.emit('room:error', { message: 'Игра уже началась' });
    if (!room.players.has(username) && room.players.size >= MAX_PLAYERS) {
      return socket.emit('room:error', { message: 'В комнате уже 5 игроков' });
    }
    if (!room.players.has(username)) {
      room.players.set(username, {
        username, socketId: socket.id, connected: true,
        level: 0, alive: true, bankedMoney: 0, finishedReason: null,
        lifelines: { fifty: true, audience: true, expert: true },
      });
    } else {
      const p = room.players.get(username);
      p.socketId = socket.id;
      p.connected = true;
    }
    userRoom.set(username, room.code);
    socket.join(room.code);
    socket.emit('room:joined', { code: room.code, topic: room.topic, hostUsername: room.hostUsername });
    broadcastPlayers(room);
  });

  socket.on('room:leave', () => {
    const code = userRoom.get(username);
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    room.players.delete(username);
    userRoom.delete(username);
    socket.leave(code);
    if (room.players.size === 0) {
      rooms.delete(code);
    } else {
      if (room.hostUsername === username) {
        room.hostUsername = Array.from(room.players.keys())[0];
      }
      broadcastPlayers(room);
    }
  });

  socket.on('room:start', () => {
    const code = userRoom.get(username);
    const room = code && rooms.get(code);
    if (!room) return socket.emit('room:error', { message: 'Вы не в комнате' });
    if (room.hostUsername !== username) return socket.emit('room:error', { message: 'Начать игру может только хост' });
    if (room.status !== 'lobby') return;
    const connectedCount = Array.from(room.players.values()).filter(p => p.connected).length;
    if (connectedCount < 1) return socket.emit('room:error', { message: 'Нужен хотя бы один игрок' });

    room.questions = buildQuestionSet(room.topic);
    room.currentIndex = 0;
    room.status = 'playing';
    room.players.forEach(p => {
      p.level = 0; p.alive = true; p.bankedMoney = 0; p.finishedReason = null;
      p.lifelines = { fifty: true, audience: true, expert: true };
    });

    io.to(room.code).emit('game:started', { topic: room.topic, total: room.questions.length });
    broadcastPlayers(room);
    sendQuestionToRoom(room);
  });

  socket.on('game:answer', ({ choiceIndex }) => {
    const code = userRoom.get(username);
    const room = code && rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const player = room.players.get(username);
    if (!player || !player.alive) return;
    if (room.answers.has(username)) return; // уже отвечал на этот вопрос
    if (typeof choiceIndex !== 'number' || choiceIndex < 0 || choiceIndex > 3) return;

    room.answers.set(username, choiceIndex);
    socket.emit('game:answerReceived', { choiceIndex });

    const alive = alivePlayers(room);
    const allAnswered = alive.every(p => room.answers.has(p.username));
    if (allAnswered) revealRound(room);
  });

  socket.on('lifeline:fifty', () => {
    const room = getPlayingRoom(username);
    if (!room) return;
    const player = room.players.get(username);
    if (!player || !player.alive || !player.lifelines.fifty) return;
    player.lifelines.fifty = false;
    const q = room.questions[room.currentIndex];
    const wrongIdxs = [0, 1, 2, 3].filter(i => i !== q.correctIndex);
    const hide = wrongIdxs.sort(() => Math.random() - 0.5).slice(0, 2);
    socket.emit('lifeline:fiftyResult', { hideIndices: hide });
  });

  socket.on('lifeline:audience', () => {
    const room = getPlayingRoom(username);
    if (!room) return;
    const player = room.players.get(username);
    if (!player || !player.alive || !player.lifelines.audience) return;
    player.lifelines.audience = false;
    const q = room.questions[room.currentIndex];
    const raw = [0, 1, 2, 3].map(i => (i === q.correctIndex ? 40 + Math.random() * 35 : Math.random() * 30));
    const total = raw.reduce((a, b) => a + b, 0);
    const pct = raw.map(v => Math.round((v / total) * 100));
    const diff = 100 - pct.reduce((a, b) => a + b, 0);
    pct[q.correctIndex] += diff;
    socket.emit('lifeline:audienceResult', { percentages: pct });
  });

  socket.on('lifeline:expert', () => {
    const room = getPlayingRoom(username);
    if (!room) return;
    const player = room.players.get(username);
    if (!player || !player.alive || !player.lifelines.expert) return;
    player.lifelines.expert = false;
    const q = room.questions[room.currentIndex];
    const isRight = Math.random() < 0.82;
    const wrongOptions = [0, 1, 2, 3].filter(i => i !== q.correctIndex);
    const guess = isRight ? q.correctIndex : wrongOptions[Math.floor(Math.random() * wrongOptions.length)];
    socket.emit('lifeline:expertResult', { guessIndex: guess, confident: isRight });
  });

  socket.on('disconnect', () => {
    const code = userRoom.get(username);
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    const player = room.players.get(username);
    if (player) player.connected = false;
    broadcastPlayers(room);
    destroyRoomIfEmpty(room);
  });

  function getPlayingRoom(uname) {
    const code = userRoom.get(uname);
    const room = code && rooms.get(code);
    if (!room || room.status !== 'playing') return null;
    return room;
  }
});

server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
