const { PrismaClient } = require('@prisma/client');
const { calculateMatchElo } = require('../services/eloService');
const { broadcastToUser, broadcastAll } = require('../websocket/broadcaster');

const prisma = new PrismaClient();

const listMatches = async (req, res, next) => {
  try {
    const { status, mode, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {
      ...(status ? { status } : {}),
      ...(mode ? { mode } : {}),
    };
    const [matches, total] = await Promise.all([
      prisma.match.findMany({
        where, skip, take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          participants: {
            include: { user: { select: { id: true, username: true, avatarUrl: true } } },
          },
        },
      }),
      prisma.match.count({ where }),
    ]);
    res.json({ matches, total, page: parseInt(page) });
  } catch (err) { next(err); }
};

const getMatch = async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: {
        participants: {
          include: {
            user: { select: { id: true, username: true, avatarUrl: true, eloGlobal: true, elo2v2: true, elo5v5: true } },
          },
        },
        dispute: true,
      },
    });
    if (!match) return res.status(404).json({ error: 'Match introuvable' });
    res.json(match);
  } catch (err) { next(err); }
};

/**
 * Soumettre le résultat d'un match.
 * Seul un participant du match peut le faire.
 * winnerTeam: 1 | 2
 */
const submitResult = async (req, res, next) => {
  try {
    const { winnerTeam } = req.body;
    if (![1, 2].includes(winnerTeam)) return res.status(400).json({ error: 'winnerTeam doit être 1 ou 2' });

    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: {
        participants: { include: { user: { select: { id: true, totalMatches: true } } } },
      },
    });

    if (!match) return res.status(404).json({ error: 'Match introuvable' });
    if (match.status !== 'IN_PROGRESS') return res.status(400).json({ error: 'Match non en cours' });

    const isParticipant = match.participants.some(p => p.userId === req.user.id);
    if (!isParticipant && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Non participant' });
    }

    // Calcul Elo
    const team1 = match.participants.filter(p => p.team === 1).map(p => ({
      userId: p.userId, elo: p.eloBefore, totalMatches: p.user.totalMatches,
    }));
    const team2 = match.participants.filter(p => p.team === 2).map(p => ({
      userId: p.userId, elo: p.eloBefore, totalMatches: p.user.totalMatches,
    }));

    const eloResults = calculateMatchElo(team1, team2, winnerTeam, match.mode);

    // Transaction DB
    await prisma.$transaction(async (tx) => {
      // Update match
      await tx.match.update({
        where: { id: match.id },
        data: { status: 'COMPLETED', winnerSide: winnerTeam, completedAt: new Date() },
      });

      // Update participants + users
      for (const result of eloResults) {
        await tx.matchParticipant.updateMany({
          where: { matchId: match.id, userId: result.userId },
          data: { eloChange: result.change, eloAfter: result.eloAfter, isWinner: result.isWinner },
        });

        const eloField = match.mode === 'TWO_V_TWO' ? 'elo2v2' : 'elo5v5';
        const userCurrent = await tx.user.findUnique({ where: { id: result.userId }, select: { eloGlobal: true, wins: true, losses: true, winStreak: true } });

        const newGlobal = Math.max(100, Math.min(3000, userCurrent.eloGlobal + result.change));
        const newWinStreak = result.isWinner ? userCurrent.winStreak + 1 : 0;

        await tx.user.update({
          where: { id: result.userId },
          data: {
            [eloField]: result.eloAfter,
            eloGlobal: newGlobal,
            wins: result.isWinner ? { increment: 1 } : undefined,
            losses: !result.isWinner ? { increment: 1 } : undefined,
            totalMatches: { increment: 1 },
            winStreak: newWinStreak,
            bestStreak: { set: Math.max(newWinStreak, userCurrent.winStreak) },
          },
        });

        await tx.eloHistory.create({
          data: {
            userId: result.userId,
            matchId: match.id,
            mode: match.mode,
            eloBefore: result.eloBefore,
            eloAfter: result.eloAfter,
            change: result.change,
            reason: result.isWinner ? 'Victoire' : 'Défaite',
          },
        });
      }
    });

    // Notifie les joueurs
    for (const result of eloResults) {
      broadcastToUser(result.userId, {
        type: 'MATCH_RESULT',
        data: { matchId: match.id, isWinner: result.isWinner, eloChange: result.change, eloAfter: result.eloAfter },
      });
    }

    broadcastAll({ type: 'LADDER_UPDATE' });

    res.json({ message: 'Résultat soumis avec succès', eloChanges: eloResults });
  } catch (err) { next(err); }
};

const createDispute = async (req, res, next) => {
  try {
    const { description } = req.body;
    const match = await prisma.match.findUnique({ where: { id: req.params.id }, include: { participants: true } });
    if (!match) return res.status(404).json({ error: 'Match introuvable' });

    const isParticipant = match.participants.some(p => p.userId === req.user.id);
    if (!isParticipant) return res.status(403).json({ error: 'Non participant' });

    const existing = await prisma.dispute.findUnique({ where: { matchId: match.id } });
    if (existing) return res.status(400).json({ error: 'Litige déjà ouvert' });

    const [dispute] = await prisma.$transaction([
      prisma.dispute.create({ data: { matchId: match.id, description } }),
      prisma.match.update({ where: { id: match.id }, data: { status: 'DISPUTED' } }),
    ]);

    res.status(201).json(dispute);
  } catch (err) { next(err); }
};

const reportMatch = async (req, res, next) => {
  try {
    const { targetUserId, reason } = req.body;
    const report = await prisma.report.create({
      data: { filerId: req.user.id, targetId: targetUserId, reason, details: `Match ID: ${req.params.id}` },
    });
    res.status(201).json(report);
  } catch (err) { next(err); }
};

module.exports = { listMatches, getMatch, submitResult, createDispute, reportMatch };
