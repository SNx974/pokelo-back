/**
 * Pokélo — Match Timeout Service
 * Si une seule équipe a soumis son score et que l'autre ne répond pas
 * dans les 3 minutes, on accepte automatiquement le score soumis.
 */

const { PrismaClient } = require('@prisma/client');
const { broadcastToUser, broadcastToRoom } = require('../websocket/broadcaster');
const { calculateMatchElo } = require('./eloService');

const prisma = new PrismaClient();

const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Finalise un match avec un vainqueur donné et met à jour les Elos.
 */
async function finalizeMatch(matchId, winnerTeam, reason = 'Résultat validé') {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      participants: { include: { user: { select: { id: true, totalMatches: true } } } },
    },
  });

  if (!match || match.status !== 'IN_PROGRESS') return;

  const team1 = match.participants.filter(p => p.team === 1).map(p => ({
    userId: p.userId, elo: p.eloBefore, totalMatches: p.user.totalMatches,
  }));
  const team2 = match.participants.filter(p => p.team === 2).map(p => ({
    userId: p.userId, elo: p.eloBefore, totalMatches: p.user.totalMatches,
  }));

  const eloResults = calculateMatchElo(team1, team2, winnerTeam, match.mode);

  await prisma.$transaction(async (tx) => {
    await tx.match.update({
      where: { id: matchId },
      data: { status: 'COMPLETED', winnerSide: winnerTeam, completedAt: new Date() },
    });

    for (const result of eloResults) {
      await tx.matchParticipant.updateMany({
        where: { matchId, userId: result.userId },
        data: { eloChange: result.change, eloAfter: result.eloAfter, isWinner: result.isWinner },
      });

      const eloField = match.mode === 'TWO_V_TWO' ? 'elo2v2' : 'elo5v5';
      const userCurrent = await tx.user.findUnique({
        where: { id: result.userId },
        select: { eloGlobal: true, winStreak: true },
      });

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
          matchId,
          mode: match.mode,
          eloBefore: result.eloBefore,
          eloAfter: result.eloAfter,
          change: result.change,
          reason: result.isWinner ? `Victoire (${reason})` : `Défaite (${reason})`,
        },
      });
    }
  });

  // Notifie les joueurs
  for (const result of eloResults) {
    broadcastToUser(result.userId, {
      type: 'MATCH_RESULT',
      data: {
        matchId,
        isWinner: result.isWinner,
        eloChange: result.change,
        eloAfter: result.eloAfter,
        reason,
      },
    });
  }

  broadcastToRoom('admin', { type: 'MATCH_COMPLETED', data: { matchId, winnerTeam, reason } });
  console.log(`[Timeout] Match ${matchId} finalisé automatiquement — Équipe ${winnerTeam} gagne (${reason})`);
}

/**
 * Vérifie les matchs en cours dont une seule équipe a soumis son score
 * depuis plus de 3 minutes.
 */
async function checkTimeouts() {
  try {
    const cutoff = new Date(Date.now() - TIMEOUT_MS);

    // Trouve les matchs IN_PROGRESS avec au moins une soumission de score
    const matches = await prisma.match.findMany({
      where: { status: 'IN_PROGRESS' },
      include: {
        scoreSubmissions: true,
      },
    });

    for (const match of matches) {
      const subs = match.scoreSubmissions;
      if (subs.length === 0) continue;
      if (subs.length === 2) continue; // Les deux ont soumis, géré par le controller

      // Une seule équipe a soumis
      const sub = subs[0];
      if (new Date(sub.submittedAt) <= cutoff) {
        console.log(`[Timeout] Match ${match.id} — équipe ${sub.teamSide} a soumis sans réponse. Validation auto.`);
        await finalizeMatch(match.id, sub.winnerTeam, 'Timeout — score accepté automatiquement');
      }
    }
  } catch (err) {
    console.error('[Timeout] Erreur lors du check:', err.message);
  }
}

/**
 * Démarre la boucle de vérification toutes les 30 secondes.
 */
function startTimeoutLoop() {
  setInterval(checkTimeouts, 30_000);
  console.log('⏱️  Match timeout loop démarrée (interval: 30s, délai: 3min)');
}

module.exports = { startTimeoutLoop, finalizeMatch };
