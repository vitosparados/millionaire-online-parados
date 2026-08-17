'use strict';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}), 'utf8');
}

function loadUsers() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveUsers(users) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function normalize(username) {
  return String(username || '').trim().toLowerCase();
}

const USERNAME_RE = /^[a-zA-Zа-яА-ЯёЁ0-9_\-]{3,20}$/;

function validateCredentials(username, password) {
  if (!USERNAME_RE.test(String(username || ''))) {
    return 'Имя пользователя: 3–20 символов (буквы, цифры, _ и -)';
  }
  if (String(password || '').length < 4) {
    return 'Пароль должен быть не короче 4 символов';
  }
  return null;
}

function registerUser(username, password) {
  const err = validateCredentials(username, password);
  if (err) return { error: err };

  const key = normalize(username);
  const users = loadUsers();
  if (users[key]) return { error: 'Такой пользователь уже зарегистрирован' };

  const passwordHash = bcrypt.hashSync(password, 10);
  users[key] = {
    username: username.trim(),
    passwordHash,
    createdAt: new Date().toISOString(),
    stats: { gamesPlayed: 0, bestScore: 0, totalWinnings: 0 },
  };
  saveUsers(users);
  return { user: { username: users[key].username } };
}

function verifyUser(username, password) {
  const key = normalize(username);
  const users = loadUsers();
  const record = users[key];
  if (!record) return { error: 'Неверное имя пользователя или пароль' };
  const ok = bcrypt.compareSync(String(password || ''), record.passwordHash);
  if (!ok) return { error: 'Неверное имя пользователя или пароль' };
  return { user: { username: record.username } };
}

function getUser(username) {
  const users = loadUsers();
  const record = users[normalize(username)];
  return record ? { username: record.username, stats: record.stats } : null;
}

// Записываем результат сыгранного раунда в статистику пользователя (не обязательно, но приятно)
function recordResult(username, amount) {
  const key = normalize(username);
  const users = loadUsers();
  const record = users[key];
  if (!record) return;
  if (!record.stats) record.stats = { gamesPlayed: 0, bestScore: 0, totalWinnings: 0 };
  record.stats.gamesPlayed += 1;
  record.stats.bestScore = Math.max(record.stats.bestScore, amount);
  record.stats.totalWinnings += amount;
  saveUsers(users);
}

module.exports = { registerUser, verifyUser, getUser, recordResult };
