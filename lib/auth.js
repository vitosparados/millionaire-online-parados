'use strict';
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('[внимание] JWT_SECRET не задан в .env — используется небезопасный секрет для разработки.');
}

function signToken(username) {
  return jwt.sign({ username }, SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    return payload.username;
  } catch (e) {
    return null;
  }
}

module.exports = { signToken, verifyToken };
