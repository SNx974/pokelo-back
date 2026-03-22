const { PrismaClient } = require('@prisma/client');
const { calculateMatchElo } = require('../services/eloService');
const { broadcastToUser } = require('../websocket/broadcaster');
const { finalizeMatch } = require('../services/matchTimeoutService');
const { acceptMatch: svcAcceptMatch, declineMatch: svcDeclineMatch } = require('../services/matchmakingService');

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
        scoreSubmissions: {
          include: { user: { select: { id: true, username: true } } },
        },
      },
    });
    if (!match) return res.status(404).json({ error: 'Match introuvable' });
    res.json(match);
  } catch (err) { next(err); }
};

/**
 * Récupère le match PENDING (en attente d'acceptation) de l'utilisateur connecté.
 */
const getPendingMatch = async (req, res, next) => {
  try {
    const participant = await prisma.matchParticipant.findFirst({
      where: { userId: req.user.id, match: { status: 'PENDING' } },
      include: {
        match: {
          include: {
            participants: {
              include: { user: { select: { id: true, username: true, avatarUrl: true } } },
            },
            acceptances: true,
          },
        },
      },
    });

    if (!participant) return res.json({ match: null });
    res.json({ match: participant.match });
  } catch (err) { next(err); }
};

/**
 * Récupère le match IN_PROGRESS de l'utilisateur connecté.
 */
const getActiveMatch = async (req, res, next) => {
  try {
    const participant = await prisma.matchParticipant.findFirst({
      where: {
        userId: req.user.id,
        match: { status: 'IN_PROGRESS' },
      },
      include: {
        match: {
          include: {
            participants: {
              include: { user: { select: { id: true, username: true, avatarUrl: true } } },
            },
          },
        },
      },
    });

    if (!participant) return res.json({ match: null });
    res.json({ match: participant.match });
  } catch (err) { next(err); }
};

/**
 * Soumettre le résultat d'un match — 1 personne par équipe valide.
 * Si les deux équipes soumettent le même résultat → match finalisé.
 * Si les résultats divergent → dispute automatique.
 */
const submitResult = async (req, res, next) => {
  try {
    const { winnerTeam } = req.body;
    if (![1, 2].includes(winnerTeam)) return res.status(400).json({ error: 'winnerTeam doit être 1 ou 2' });

    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: {
        participants: true,
        scoreSubmissions: true,
      },
    });

    if (!match) return res.status(404).json({ error: 'Match introuvable' });
    if (match.status !== 'IN_PROGRESS') return res.status(400).json({ error: 'Match non en cours' });

    // Vérifie participation
    const myParticipant = match.participants.find(p => p.userId === req.user.id);
    if (!myParticipant && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Non participant' });
    }

    const teamSide = myParticipant ? myParticipant.team : null;

    // Vérifie qu'une soumission de cette équipe n'existe pas déjà
    const alreadySubmitted = match.scoreSubmissions.find(s => s.teamSide === teamSide);
    if (alreadySubmitted) {
      return res.status(400).json({ error: 'Votre équipe a déjà soumis un résultat.' });
    }

    // Enregistre la soumission
    await prisma.matchScoreSubmission.create({
      data: {
        matchId: match.id,
        userId: req.user.id,
        teamSide,
        winnerTeam,
      },
    });

    // Notifie les participants du match de la nouvelle soumission
    const allUserIds = match.participants.map(p => p.userId);
    for (const uid of allUserIds) {
      broadcastToUser(uid, {
        type: 'SCORE_SUBMITTED',
        data: { matchId: match.id, teamSide, winnerTeam },
      });
    }

    // Vérifie si les deux équipes ont soumis
    const updatedSubmissions = [...match.scoreSubmissions, { teamSide, winnerTeam }];
    const team1Sub = updatedSubmissions.find(s => s.teamSide === 1);
    const team2Sub = updatedSubmissions.find(s => s.teamSide === 2);

    if (team1Sub && team2Sub) {
      if (team1Sub.winnerTeam === team2Sub.winnerTeam) {
        // Accord parfait → finalisation
        await finalizeMatch(match.id, team1Sub.winnerTeam, 'Validé par les deux équipes');
        return res.json({ message: 'Résultat validé par les deux équipes !', status: 'COMPLETED' });
      } else {
        // Désaccord → dispute automatique
        const existing = await prisma.dispute.findUnique({ where: { matchId: match.id } });
        if (!existing) {
          await prisma.$transaction([
            prisma.dispute.create({
              data: {
                matchId: match.id,
                description: `Désaccord automatique — Équipe 1 déclare: Équipe ${team1Sub.winnerTeam} gagnante. Équipe 2 déclare: Équipe ${team2Sub.winnerTeam} gagnante.`,
              },
            }),
            prisma.match.update({ where: { id: match.id }, data: { status: 'DISPUTED' } }),
          ]);
        }

        for (const uid of allUserIds) {
          broadcastToUser(uid, {
            type: 'MATCH_DISPUTED',
            data: { matchId: match.id, reason: 'Scores divergents — litige créé automatiquement.' },
          });
        }

        return res.json({ message: 'Scores divergents. Litige créé automatiquement.', status: 'DISPUTED' });
      }
    }

    res.json({
      message: 'Score soumis. En attente de la confirmation de l\'autre équipe.',
      status: 'PENDING_CONFIRMATION',
    });
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

// ─── Chat ─────────────────────────────────────────────────────────────────────

/**
 * Récupère les messages du chat d'un match.
 * Réservé aux participants du match.
 */
const getChatMessages = async (req, res, next) => {
  try {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: { participants: true },
    });
    if (!match) return res.status(404).json({ error: 'Match introuvable' });

    const isParticipant = match.participants.some(p => p.userId === req.user.id);
    if (!isParticipant && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Accès réservé aux participants' });
    }

    const messages = await prisma.chatMessage.findMany({
      where: { matchId: req.params.id },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, username: true, avatarUrl: true } } },
    });

    res.json(messages);
  } catch (err) { next(err); }
};

/**
 * Envoie un message dans le chat du match.
 * Réservé aux participants. Le message est broadcasté via WS.
 */
const sendChatMessage = async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message vide' });
    if (content.length > 500) return res.status(400).json({ error: 'Message trop long (500 chars max)' });

    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: { participants: true },
    });
    if (!match) return res.status(404).json({ error: 'Match introuvable' });

    const isParticipant = match.participants.some(p => p.userId === req.user.id);
    if (!isParticipant && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Accès réservé aux participants' });
    }

    if (!['IN_PROGRESS', 'DISPUTED'].includes(match.status)) {
      return res.status(400).json({ error: 'Le chat est fermé pour ce match' });
    }

    const message = await prisma.chatMessage.create({
      data: { matchId: match.id, userId: req.user.id, content: content.trim() },
      include: { user: { select: { id: true, username: true, avatarUrl: true } } },
    });

    // Broadcast aux participants via WS
    const allUserIds = match.participants.map(p => p.userId);
    for (const uid of allUserIds) {
      broadcastToUser(uid, {
        type: 'CHAT_MESSAGE',
        data: { matchId: match.id, message },
      });
    }

    res.status(201).json(message);
  } catch (err) { next(err); }
};

const acceptMatchHandler = async (req, res, next) => {
  try {
    const result = await svcAcceptMatch(req.params.id, req.user.id);
    res.json({ message: 'Accepté', allAccepted: result.allAccepted });
  } catch (err) {
    if (err.message.includes('introuvable') || err.message.includes('participant')) {
      return res.status(404).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message });
  }
};

const declineMatchHandler = async (req, res, next) => {
  try {
    await svcDeclineMatch(req.params.id, req.user.id);
    res.json({ message: 'Refusé — match annulé.' });
  } catch (err) {
    if (err.message.includes('introuvable') || err.message.includes('participant')) {
      return res.status(404).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message });
  }
};

module.exports = {
  listMatches,
  getMatch,
  getPendingMatch,
  getActiveMatch,
  submitResult,
  createDispute,
  reportMatch,
  getChatMessages,
  sendChatMessage,
  acceptMatchHandler,
  declineMatchHandler,
};
