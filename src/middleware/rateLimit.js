// Rate limiting désactivé temporairement
const passthrough = (req, res, next) => next();

const globalRateLimit      = passthrough;
const authRateLimit        = passthrough;
const matchmakingRateLimit = passthrough;

module.exports = { globalRateLimit, authRateLimit, matchmakingRateLimit };
