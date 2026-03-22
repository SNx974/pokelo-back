const { PrismaClient } = require('@prisma/client');
const { broadcastToUser } = require('../websocket/broadcaster');
const { finalizeMatch } = require('../services/matchTimeoutService');

const prisma = new PrismaClient();

const getDashboard = async (req, res, next) => {
  try {
    const now = new Date();
    const day  = new Date(now - 24 * 60 * 60 * 1000);
    const week = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers, newUsersToday, newUsersWeek,
      totalMatches, matchesToday, matchesWeek,
      activeDisputes, openReports,
      totalTeams, activeMatches,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: day } } }),
      prisma.user.count({ where: { createdAt: { gte: week } } }),
      prisma.match.count({ where: { status: 'COMPLETED' } }),
      prisma.match.count({ where: { status: 'COMPLETED', completedAt: { gte: day } } }),
      prisma.match.count({ where: { status: 'COMPLETED', completedAt: { gte: week } } }),
      prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
      prisma.report.count({ where: { isResolved: false } }),
      prisma.team.count(),
      prisma.match.count({ where: { status: 'IN_PROGRESS' } }),
    ]);

    res.json({
      users:      { total: totalUsers,   today: newUsersToday,  thisWeek: newUsersWeek },
      matches:    { total: totalMatches, today: matchesToday,   thisWeek: matchesWeek, active: activeMatches },
      moderation: { activeDisputes, openReports },
      teams:      { total: totalTeams },
    });
  } catch (err) { next(err); }
};

const listUsers = async (req, res, next) => {
  try {
    const { q, isBanned, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {
      ...(q ? { OR: [
        { username: { contains: q, mode: 'insensitive' } },
        { email:    { contains: q, mode: 'insensitive' } },
      ]} : {}),
      ...(isBanned !== undefined ? { isBanned: isBanned === 'true' } : {}),
    };
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where, skip, take: parseInt(limit),
        select: {
          id: true, username: true, email: true, role: true,
          isBanned: true, banExpiresAt: true,
          eloGlobal: true, elo2v2: true, elo5v5: true,
          wins: true, losses: true, totalMatches: true,
          region: true, createdAt: true, lastActiveAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, total, page: parseInt(page) });
  } catch (err) { next(err); }
};

const banUser = async (req, res, next) => {
  try {
    const { reason, duration } = req.body;
    const banExpiresAt = duration ? new Date(Date.now() + duration * 60 * 60 * 1000) : null;

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isBanned: true, banExpiresAt },
    });

    await prisma.sanction.create({
      data: {
        userId: user.id,
        type: duration ? 'TEMP_BAN' : 'PERM_BAN',
        reason: reason || 'Violation des règles',
        duration,
        expiresAt: banExpiresAt,
      },
    });

    broadcastToUser(user.id, { type: 'ACCOUNT_BANNED', reason });
    res.json({ message: `${user.username} banni`, banExpiresAt });
  } catch (err) { next(err); }
};

const unbanUser = async (req, res, next) => {
  try {
    await prisma.user.update({ where: { id: req.params.id }, data: { isBanned: false, banExpiresAt: null } });
    await prisma.sanction.updateMany({ where: { userId: req.params.id, isActive: true }, data: { isActive: false } });
    res.json({ message: 'Utilisateur débanni' });
  } catch (err) { next(err); }
};

const updateUserRole = async (req, res, next) => {
  try {
    const { role } = req.body;
    const validRoles = ['USER', 'MODERATOR', 'ADMIN'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { role },
      select: { id: true, username: true, role: true },
    });
    res.json({ message: `Rôle de ${user.username} mis à jour : ${role}`, user });
  } catch (err) { next(err); }
};

const listDisputes = async (req, res, next) => {
  try {
    const { status = 'OPEN' } = req.query;
    const disputes = await prisma.dispute.findMany({
      where: status !== 'ALL' ? { status } : {},
      include: {
        match: {
          include: {
            participants: {
              include: { user: { select: { id: true, username: true, avatarUrl: true } } },
            },
            scoreSubmissions: {
              include: { user: { select: { id: true, username: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(disputes);
  } catch (err) { next(err); }
};

const resolveDispute = async (req, res, next) => {
  try {
    const { status, resolution, winnerTeam } = req.body;

    // Si l'admin force un vainqueur
    if (winnerTeam && [1, 2].includes(winnerTeam)) {
      const dispute = await prisma.dispute.findUnique({
        where: { id: req.params.id },
        include: { match: true },
      });
      if (!dispute) return res.status(404).json({ error: 'Litige introuvable' });

      if (dispute.match.status !== 'COMPLETED') {
        await finalizeMatch(dispute.match.id, winnerTeam, `Override admin — ${resolution || 'Décision administrative'}`);
      }
    }

    const dispute = await prisma.dispute.update({
      where: { id: req.params.id },
      data: {
        status: status || 'RESOLVED',
        resolution: resolution || 'Résolu par admin',
        resolvedAt: new Date(),
      },
    });

    res.json(dispute);
  } catch (err) { next(err); }
};

const listReports = async (req, res, next) => {
  try {
    const { isResolved } = req.query;
    const where = isResolved !== undefined ? { isResolved: isResolved === 'true' } : { isResolved: false };
    const reports = await prisma.report.findMany({
      where,
      include: {
        filer:  { select: { id: true, username: true, avatarUrl: true } },
        target: { select: { id: true, username: true, avatarUrl: true, isBanned: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(reports);
  } catch (err) { next(err); }
};

const resolveReport = async (req, res, next) => {
  try {
    await prisma.report.update({ where: { id: req.params.id }, data: { isResolved: true } });
    res.json({ message: 'Signalement résolu' });
  } catch (err) { next(err); }
};

const overrideMatchResult = async (req, res, next) => {
  try {
    const { winnerTeam } = req.body;
    if (![1, 2].includes(winnerTeam)) return res.status(400).json({ error: 'winnerTeam invalide' });

    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Match introuvable' });

    await finalizeMatch(match.id, winnerTeam, 'Override admin');
    res.json({ message: `Résultat forcé : Équipe ${winnerTeam} gagne` });
  } catch (err) { next(err); }
};

// ─── News (admin) ─────────────────────────────────────────────────────────────

const listAllNews = async (req, res, next) => {
  try {
    const news = await prisma.news.findMany({
      include: { author: { select: { id: true, username: true } } },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(news);
  } catch (err) { next(err); }
};

const createNews = async (req, res, next) => {
  try {
    const { title, content, coverImage, isPinned, isPublished } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Titre et contenu requis' });
    const news = await prisma.news.create({
      data: { title, content, coverImage, isPinned: !!isPinned, isPublished: !!isPublished, authorId: req.user.id },
    });
    res.status(201).json(news);
  } catch (err) { next(err); }
};

const updateNews = async (req, res, next) => {
  try {
    const news = await prisma.news.update({ where: { id: req.params.id }, data: req.body });
    res.json(news);
  } catch (err) { next(err); }
};

const deleteNews = async (req, res, next) => {
  try {
    await prisma.news.delete({ where: { id: req.params.id } });
    res.json({ message: 'Article supprimé' });
  } catch (err) { next(err); }
};

module.exports = {
  getDashboard, listUsers, banUser, unbanUser, updateUserRole,
  listDisputes, resolveDispute,
  listReports, resolveReport,
  overrideMatchResult,
  listAllNews, createNews, updateNews, deleteNews,
};
