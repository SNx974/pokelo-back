const { PrismaClient } = require('@prisma/client');
const { getRank, calcWinrate } = require('../services/eloService');
const { getOnlineCount } = require('../websocket/broadcaster');

const prisma = new PrismaClient();

const getPlayersLadder = async (req, res, next) => {
  try {
    const { mode = 'global', region, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const eloField = mode === 'TWO_V_TWO' ? 'elo2v2' : mode === 'FIVE_V_FIVE' ? 'elo5v5' : 'eloGlobal';

    const where = {
      isBanned: false,
      ...(region ? { region } : {}),
    };

    const [players, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, username: true, avatarUrl: true, region: true, preferredRole: true,
          eloGlobal: true, elo2v2: true, elo5v5: true,
          wins: true, losses: true, totalMatches: true, winStreak: true,
          lastActiveAt: true,
        },
        orderBy: { [eloField]: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.user.count({ where }),
    ]);

    const ranked = players.map((p, idx) => ({
      ...p,
      rank: getRank(p[eloField]),
      winrate: calcWinrate(p.wins, p.losses),
      position: skip + idx + 1,
    }));

    res.json({ players: ranked, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { next(err); }
};

const getTeamsLadder = async (req, res, next) => {
  try {
    const { region, page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = { ...(region ? { region } : {}) };

    const [teams, total] = await Promise.all([
      prisma.team.findMany({
        where,
        include: {
          members: {
            include: { user: { select: { id: true, username: true, avatarUrl: true } } },
            take: 5,
            orderBy: { role: 'asc' },
          },
        },
        orderBy: { eloTeam: 'desc' },
        skip,
        take: parseInt(limit),
      }),
      prisma.team.count({ where }),
    ]);

    const ranked = teams.map((t, idx) => ({
      ...t,
      position: skip + idx + 1,
      winrate: calcWinrate(t.wins, t.losses),
    }));

    res.json({ teams: ranked, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { next(err); }
};

const getGlobalStats = async (req, res, next) => {
  try {
    const [totalPlayers, totalMatches, totalTeams, recentMatches] = await Promise.all([
      prisma.user.count({ where: { isBanned: false } }),
      prisma.match.count({ where: { status: 'COMPLETED' } }),
      prisma.team.count(),
      prisma.match.count({
        where: { status: 'COMPLETED', completedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]);

    res.json({
      totalPlayers,
      totalMatches,
      totalTeams,
      matchesLast24h: recentMatches,
      onlinePlayers: getOnlineCount(),
    });
  } catch (err) { next(err); }
};

module.exports = { getPlayersLadder, getTeamsLadder, getGlobalStats };
