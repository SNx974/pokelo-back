const { PrismaClient } = require('@prisma/client');
const { getRank, calcWinrate } = require('../services/eloService');
const path = require('path');

const prisma = new PrismaClient();

const userPublicSelect = {
  id: true, username: true, avatarUrl: true, region: true, preferredRole: true,
  eloGlobal: true, elo2v2: true, elo5v5: true,
  wins: true, losses: true, totalMatches: true, winStreak: true, bestStreak: true,
  createdAt: true, lastActiveAt: true,
};

const search = async (req, res, next) => {
  try {
    const { q, region, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      isBanned: false,
      ...(q ? { username: { contains: q, mode: 'insensitive' } } : {}),
      ...(region ? { region } : {}),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, select: userPublicSelect, orderBy: { eloGlobal: 'desc' }, skip, take: parseInt(limit) }),
      prisma.user.count({ where }),
    ]);

    res.json({ users: users.map(u => ({ ...u, rank: getRank(u.eloGlobal), winrate: calcWinrate(u.wins, u.losses) })), total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { next(err); }
};

const getProfile = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        ...userPublicSelect,
        teamMemberships: {
          include: { team: { select: { id: true, name: true, tag: true, avatarUrl: true, eloTeam: true } } },
        },
      },
    });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    res.json({ ...user, rank: getRank(user.eloGlobal), rank2v2: getRank(user.elo2v2), rank5v5: getRank(user.elo5v5), winrate: calcWinrate(user.wins, user.losses) });
  } catch (err) { next(err); }
};

const getMatchHistory = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, mode } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      userId: req.params.id,
      match: {
        status: 'COMPLETED',
        ...(mode ? { mode } : {}),
      },
    };

    const [participants, total] = await Promise.all([
      prisma.matchParticipant.findMany({
        where,
        include: {
          match: {
            include: {
              participants: {
                include: { user: { select: { id: true, username: true, avatarUrl: true, eloGlobal: true } } },
              },
            },
          },
        },
        orderBy: { match: { completedAt: 'desc' } },
        skip,
        take: parseInt(limit),
      }),
      prisma.matchParticipant.count({ where }),
    ]);

    res.json({ matches: participants, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { next(err); }
};

const getEloHistory = async (req, res, next) => {
  try {
    const history = await prisma.eloHistory.findMany({
      where: { userId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(history);
  } catch (err) { next(err); }
};

const updateProfile = async (req, res, next) => {
  try {
    const { username, region, preferredRole } = req.body;

    // Check username taken
    if (username) {
      const existing = await prisma.user.findFirst({ where: { username, NOT: { id: req.user.id } } });
      if (existing) return res.status(409).json({ error: 'Ce pseudo est déjà utilisé' });
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { ...(username && { username }), ...(region && { region }), ...(preferredRole !== undefined && { preferredRole }) },
      select: userPublicSelect,
    });

    res.json(updated);
  } catch (err) { next(err); }
};

const uploadAvatar = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier envoyé' });

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    await prisma.user.update({ where: { id: req.user.id }, data: { avatarUrl } });

    res.json({ avatarUrl });
  } catch (err) { next(err); }
};

module.exports = { search, getProfile, getMatchHistory, getEloHistory, updateProfile, uploadAvatar };
