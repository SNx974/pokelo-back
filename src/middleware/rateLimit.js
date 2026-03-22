const rateLimit = require('express-rate-limit');

const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez dans quelques minutes.' },
});

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes.' },
  skipSuccessfulRequests: true,
});

const matchmakingRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Trop de requêtes matchmaking.' },
});

module.exports = { globalRateLimit, authRateLimit, matchmakingRateLimit };
