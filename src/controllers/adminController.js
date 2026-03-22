const { PrismaClient } = require('@prisma/client');
const { broadcastToUser } = require('../websocket/broadcaster');

const prisma = new PrismaClient();

const getDashboard = async (req, res, next) => {
  try {
    const now = new Date();
    const day = new Date(now - 24 * 60 * 60 * 1000);
    const week = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers, newUsersToday, newUsersWeek,
      totalMatches, matchesToday, matchesWeek,
      activeDisputes, openReports,
      totalTeams,
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
    ]);

    res.json({
      users: { total: totalUsers, today: newUsersToday, thisWeek: newUsersWeek },
      matches: { total: totalMatches, today: matchesToday, thisWeek: matchesWeek },
      moderation: { activeDisputes, openReports },
      teams: { total: totalTeams },
    });
  } catch (err) { next(err); }
};

const listUsers = async (req, res, next) => {
  try {
    const { q, isBanned, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {
      ...(q ? { OR: [{ username: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } : {}),
      ...(isBanned !== undefined ? { isBanned: isBanned === 'true' } : {}),
    };
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where, skip, take: parseInt(limit),
        select: { id: true, username: true, email: true, role: true, isBanned: true, eloGlobal: true, createdAt: true, lastActiveAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, total, page: parseInt(page) });
  } catch (err) { next(err); }
};

const banUser = async (req, res, next) => {
  try {
    const { reason, duration } = req.body; // duration en heures, null = perm ban
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

const listDisputes = async (req, res, next) => {
  try {
    const { status = 'OPEN' } = req.query;
    const disputes = await prisma.dispute.findMany({
      where: status !== 'ALL' ? { status } : {},
      include: {
        match: {
          include: {
            participants: { include: { user: { select: { id: true, username: true } } } },
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
    const { status, resolution } = req.body;
    const dispute = await prisma.dispute.update({
      where: { id: req.params.id },
      data: { status, resolution, resolvedAt: new Date() },
    });
    if (status === 'RESOLVED') {
      await prisma.match.update({ where: { id: dispute.matchId }, data: { status: 'COMPLETED' } });
    }
    res.json(dispute);
  } catch (err) { next(err); }
};

const listReports = async (req, res, next) => {
  try {
    const reports = await prisma.report.findMany({
      where: { isResolved: false },
      include: {
        filer: { select: { id: true, username: true } },
        target: { select: { id: true, username: true } },
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
    const match = await prisma.match.findUnique({ where: { id: req.params.id } });
    if (!match) return res.status(404).json({ error: 'Match introuvable' });

    await prisma.match.update({
      where: { id: req.params.id },
      data: { winnerSide: winnerTeam, status: 'COMPLETED' },
    });
    res.json({ message: 'Résultat corrigé par admin' });
  } catch (err) { next(err); }
};

module.exports = { getDashboard, listUsers, banUser, unbanUser, listDisputes, resolveDispute, listReports, resolveReport, overrideMatchResult };
