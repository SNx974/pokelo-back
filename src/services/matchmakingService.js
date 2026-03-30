/**
 * Pokélo — Matchmaking Service
 * File d'attente intelligente basée sur Elo + temps d'attente.
 * Flux PENDING: match créé → 30s pour accepter → IN_PROGRESS ou CANCELLED.
 * Si refus ou timeout: refuseur pénalisé, accepteurs réintégrés en file.
 */

const { PrismaClient } = require('@prisma/client');
const { broadcastToUser, isUserOnline } = require('../websocket/broadcaster');

const prisma = new PrismaClient();

// ─── État en mémoire ──────────────────────────────────────────────────────────

const queues = {
  TWO_V_TWO:   { SOLO: [], TEAM: [] },
  FIVE_V_FIVE: { SOLO: [], TEAM: [] },
};

const TEAM_SIZES        = { TWO_V_TWO: 2, FIVE_V_FIVE: 5 };
const BASE_ELO_RANGE    = 150;
const ELO_EXPAND_PER_30S = 50;
const MAX_ELO_RANGE     = 600;
const ACCEPT_TIMEOUT_MS = 30_000; // 30 secondes pour accepter

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getEloTolerance(waitSeconds) {
  const expansions = Math.floor(waitSeconds / 30);
  return Math.min(BASE_ELO_RANGE + expansions * ELO_EXPAND_PER_30S, MAX_ELO_RANGE);
}

// ─── Rejoindre / Quitter la file ─────────────────────────────────────────────

async function joinQueue(userId, mode, queueType, teamId = null) {
  // Vérifie déjà en queue
  const existing = await prisma.queueEntry.findFirst({ where: { userId, isActive: true } });
  if (existing) throw new Error('Vous êtes déjà en file d\'attente.');

  // Vérifie match actif (IN_PROGRESS ou PENDING acceptation)
  const activeMatch = await prisma.matchParticipant.findFirst({
    where: { userId, match: { status: { in: ['IN_PROGRESS', 'PENDING'] } } },
  });
  if (activeMatch) throw new Error('Vous avez déjà un match en cours. Terminez-le avant de rejoindre la file.');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('Utilisateur introuvable.');

  // Vérification online pour les équipes
  if (queueType === 'TEAM' && teamId) {
    await checkTeamOnline(teamId, mode);
  }

  const eloField = mode === 'TWO_V_TWO' ? 'elo2v2' : 'elo5v5';
  const elo = user[eloField];

  const entry = await prisma.queueEntry.create({
    data: {
      userId: queueType === 'SOLO' ? userId : null,
      teamId: queueType === 'TEAM' ? teamId : null,
      mode,
      queueType,
      eloAtEntry: elo,
      isActive: true,
    },
  });

  const queueEntry = {
    id: entry.id,
    userId: queueType === 'SOLO' ? userId : null,
    teamId,
    elo,
    joinedAt: Date.now(),
    mode,
    queueType,
  };

  queues[mode][queueType].push(queueEntry);
  console.log(`[Queue] ${user.username} rejoint ${mode}/${queueType} (Elo: ${elo})`);

  broadcastToUser(userId, { type: 'QUEUE_JOINED', data: { mode, queueType, elo } });
  broadcastQueueSlotsUpdate(mode, queueType);

  await tryMatchmaking(mode, queueType);
  return entry;
}

// Broadcast le nombre de slots remplis à tous les joueurs dans la file
function broadcastQueueSlotsUpdate(mode, queueType) {
  const queue = queues[mode][queueType];
  const teamSize = TEAM_SIZES[mode];
  const payload = {
    type: 'QUEUE_SLOTS_UPDATE',
    data: { count: queue.length, total: teamSize * 2, mode, queueType },
  };
  for (const entry of queue) {
    if (entry.userId) broadcastToUser(entry.userId, payload);
  }
}

async function leaveQueue(userId) {
  await prisma.queueEntry.updateMany({
    where: { userId, isActive: true },
    data: { isActive: false },
  });

  for (const mode of ['TWO_V_TWO', 'FIVE_V_FIVE']) {
    for (const type of ['SOLO', 'TEAM']) {
      const before = queues[mode][type].length;
      queues[mode][type] = queues[mode][type].filter(e => e.userId !== userId);
      if (queues[mode][type].length < before) {
        broadcastQueueSlotsUpdate(mode, type);
      }
    }
  }

  broadcastToUser(userId, { type: 'QUEUE_LEFT' });
}

// ─── Vérification online ──────────────────────────────────────────────────────

async function checkTeamOnline(teamId, mode) {
  const teamSize = TEAM_SIZES[mode];
  const members = await prisma.teamMember.findMany({
    where: { teamId },
    select: { userId: true, user: { select: { username: true } } },
  });

  if (members.length < teamSize) {
    throw new Error(`Votre équipe n'a pas assez de membres (${members.length}/${teamSize}).`);
  }

  const offlineMembers = members.filter(m => !isUserOnline(m.userId));
  if (offlineMembers.length > 0) {
    const names = offlineMembers.map(m => m.user.username).join(', ');
    throw new Error(`Membres hors ligne: ${names}. Tous les membres doivent être connectés.`);
  }
}

// ─── Algorithme de balancement des équipes ────────────────────────────────────
// Trouve la répartition la plus équilibrée possible en testant toutes les
// combinaisons possibles (C(n*2, n)) et en minimisant la différence d'Elo moyen.
// 2v2 → C(4,2) = 6 combinaisons | 5v5 → C(10,5) = 252 combinaisons (très rapide)

function getCombinations(arr, k) {
  const result = [];
  function combine(start, combo) {
    if (combo.length === k) { result.push([...combo]); return; }
    for (let i = start; i <= arr.length - (k - combo.length); i++) {
      combine(i + 1, [...combo, arr[i]]);
    }
  }
  combine(0, []);
  return result;
}

function balanceTeams(players, teamSize) {
  const sorted = [...players].sort((a, b) => b.elo - a.elo);

  let bestDiff = Infinity;
  let bestTeam1 = null;
  let bestTeam2 = null;

  const combos = getCombinations(sorted, teamSize);

  for (const team1 of combos) {
    const team1Ids = new Set(team1.map(p => p.userId));
    const team2    = sorted.filter(p => !team1Ids.has(p.userId));

    const avg1 = team1.reduce((s, p) => s + p.elo, 0) / teamSize;
    const avg2 = team2.reduce((s, p) => s + p.elo, 0) / teamSize;
    const diff = Math.abs(avg1 - avg2);

    if (diff < bestDiff) {
      bestDiff  = diff;
      bestTeam1 = team1;
      bestTeam2 = team2;
    }
  }

  const avgT1 = Math.round(bestTeam1.reduce((s, p) => s + p.elo, 0) / teamSize);
  const avgT2 = Math.round(bestTeam2.reduce((s, p) => s + p.elo, 0) / teamSize);
  console.log(`[Balancing] Meilleure répartition trouvée — diff Elo: ${Math.round(bestDiff)} (T1 avg: ${avgT1} | T2 avg: ${avgT2})`);

  return { team1: bestTeam1, team2: bestTeam2 };
}

// ─── Matchmaking ──────────────────────────────────────────────────────────────

async function tryMatchmaking(mode, queueType) {
  const teamSize = TEAM_SIZES[mode];

  if (queueType === 'SOLO') {
    // Boucle : crée TOUS les matchs possibles en une seule passe
    let foundMatch = true;
    while (foundMatch) {
      foundMatch = false;

      const currentQueue = queues[mode][queueType];
      if (currentQueue.length < teamSize * 2) break;

      currentQueue.sort((a, b) => a.elo - b.elo);

      for (let i = 0; i <= currentQueue.length - teamSize * 2; i++) {
        const group = currentQueue.slice(i, i + teamSize * 2);
        const now = Date.now();
        const minElo = group[0].elo;
        const maxElo = group[group.length - 1].elo;

        const maxTolerance = Math.max(
          ...group.map(e => getEloTolerance((now - e.joinedAt) / 1000))
        );

        if (maxElo - minElo <= maxTolerance) {
          const { team1, team2 } = balanceTeams(group, teamSize);
          await createPendingMatch(team1, team2, mode, queueType);

          const matchedIds = new Set(group.map(e => e.userId).filter(Boolean));
          queues[mode][queueType] = queues[mode][queueType].filter(e => !matchedIds.has(e.userId));

          foundMatch = true; // relance la boucle avec la file mise à jour
          break;
        }
      }
    }
  }
}

// ─── Création du match PENDING ────────────────────────────────────────────────

async function createPendingMatch(team1Entries, team2Entries, mode, queueType) {
  const allEntries = [...team1Entries, ...team2Entries];
  const expiresAt = new Date(Date.now() + ACCEPT_TIMEOUT_MS);

  // Récupère les infos joueurs pour le reveal du lobby
  const allUserIds = allEntries.map(e => e.userId).filter(Boolean);
  const users = await prisma.user.findMany({
    where: { id: { in: allUserIds } },
    select: { id: true, username: true, avatarUrl: true },
  });
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  const match = await prisma.match.create({
    data: {
      mode,
      queueType,
      status: 'PENDING',
      acceptExpiresAt: expiresAt,
      participants: {
        create: [
          ...team1Entries.map(e => ({ userId: e.userId, team: 1, eloBefore: e.elo })),
          ...team2Entries.map(e => ({ userId: e.userId, team: 2, eloBefore: e.elo })),
        ],
      },
      acceptances: {
        create: allEntries.map(e => ({ userId: e.userId })),
      },
    },
    include: { participants: true, acceptances: true },
  });

  // Désactive les entrées de queue (allUserIds déjà déclaré plus haut)
  await prisma.queueEntry.updateMany({
    where: { userId: { in: allUserIds }, isActive: true },
    data: { isActive: false },
  });

  // Notifie tous les joueurs
  const matchData = {
    type: 'MATCH_FOUND',
    data: {
      matchId: match.id,
      mode,
      queueType,
      expiresAt: expiresAt.toISOString(),
      team1: team1Entries.map(e => ({ userId: e.userId, elo: e.elo, username: userMap[e.userId]?.username || '???', avatarUrl: userMap[e.userId]?.avatarUrl || null })),
      team2: team2Entries.map(e => ({ userId: e.userId, elo: e.elo, username: userMap[e.userId]?.username || '???', avatarUrl: userMap[e.userId]?.avatarUrl || null })),
    },
  };

  for (const entry of allEntries) {
    if (entry.userId) broadcastToUser(entry.userId, matchData);
  }

  broadcastToUser('admin', { type: 'MATCH_CREATED', data: { matchId: match.id, mode } });
  console.log(`[Matchmaking] Match PENDING créé: ${match.id} (${mode} ${queueType}) — expire dans 30s`);

  // Lance le timer d'expiration
  setTimeout(() => handleMatchAcceptTimeout(match.id), ACCEPT_TIMEOUT_MS + 2000);

  return match;
}

// ─── Expiration du timer d'acceptation ───────────────────────────────────────

async function handleMatchAcceptTimeout(matchId) {
  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: { participants: true, acceptances: true },
    });
    if (!match || match.status !== 'PENDING') return; // déjà traité

    // Ceux qui n'ont pas répondu (accepted === null) sont traités comme refus
    const notResponded = match.acceptances.filter(a => a.accepted === null);
    const refusers     = match.acceptances.filter(a => a.accepted === false);
    const penalized    = [...notResponded, ...refusers].map(a => a.userId);
    const accepters    = match.acceptances.filter(a => a.accepted === true).map(a => a.userId);

    await cancelMatchAndRequeue(match, penalized, accepters, 'Timeout d\'acceptation');
  } catch (err) {
    console.error('[Matchmaking] Erreur timeout:', err.message);
  }
}

// ─── Accepter / Refuser un match ─────────────────────────────────────────────

async function acceptMatch(matchId, userId) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { participants: true, acceptances: true },
  });
  if (!match) throw new Error('Match introuvable');
  if (match.status !== 'PENDING') throw new Error('Ce match n\'est plus en attente');

  const acceptance = match.acceptances.find(a => a.userId === userId);
  if (!acceptance) throw new Error('Vous n\'êtes pas participant de ce match');
  if (acceptance.accepted !== null) throw new Error('Vous avez déjà répondu');

  // Marque comme accepté
  await prisma.matchAcceptance.update({
    where: { id: acceptance.id },
    data: { accepted: true, respondedAt: new Date() },
  });

  // Recharge les acceptances
  const updated = await prisma.matchAcceptance.findMany({ where: { matchId } });
  const allAccepted = updated.every(a => a.accepted === true);

  if (allAccepted) {
    // Tout le monde a accepté → IN_PROGRESS
    await prisma.match.update({
      where: { id: matchId },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });

    const allUserIds = match.participants.map(p => p.userId);
    for (const uid of allUserIds) {
      broadcastToUser(uid, {
        type: 'MATCH_STARTED',
        data: { matchId, mode: match.mode },
      });
    }
    console.log(`[Matchmaking] Match ${matchId} → IN_PROGRESS`);
  } else {
    // Notifie les autres que quelqu'un a accepté
    broadcastToUser(userId, { type: 'MATCH_ACCEPT_OK', data: { matchId } });
    // Met à jour le compteur pour les autres joueurs
    const pendingCount = updated.filter(a => a.accepted === null).length;
    for (const uid of match.participants.map(p => p.userId)) {
      if (uid !== userId) {
        broadcastToUser(uid, {
          type: 'MATCH_ACCEPT_UPDATE',
          data: { matchId, pendingCount, acceptedUserId: userId },
        });
      }
    }
  }

  return { allAccepted };
}

async function declineMatch(matchId, userId) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { participants: true, acceptances: true },
  });
  if (!match) throw new Error('Match introuvable');
  if (match.status !== 'PENDING') throw new Error('Ce match n\'est plus en attente');

  const acceptance = match.acceptances.find(a => a.userId === userId);
  if (!acceptance) throw new Error('Vous n\'êtes pas participant de ce match');

  await prisma.matchAcceptance.update({
    where: { id: acceptance.id },
    data: { accepted: false, respondedAt: new Date() },
  });

  const accepters = match.acceptances
    .filter(a => a.userId !== userId && a.accepted === true)
    .map(a => a.userId);

  await cancelMatchAndRequeue(match, [userId], accepters, 'Refus d\'un joueur');
}

// ─── Annulation + Réintégration ───────────────────────────────────────────────

async function cancelMatchAndRequeue(match, penalizedIds, requeueIds, reason) {
  // Annule le match
  await prisma.match.update({
    where: { id: match.id },
    data: { status: 'CANCELLED' },
  });

  const allUserIds = match.participants.map(p => p.userId);

  // Notifie tout le monde
  for (const uid of allUserIds) {
    broadcastToUser(uid, {
      type: 'MATCH_CANCELLED',
      data: { matchId: match.id, reason },
    });
  }

  // Réintègre les accepteurs dans la file
  for (const uid of requeueIds) {
    try {
      const participant = match.participants.find(p => p.userId === uid);
      if (!participant) continue;

      const user = await prisma.user.findUnique({ where: { id: uid } });
      if (!user) continue;

      const eloField = match.mode === 'TWO_V_TWO' ? 'elo2v2' : 'elo5v5';
      const elo = user[eloField];

      const entry = await prisma.queueEntry.create({
        data: {
          userId: uid,
          mode: match.mode,
          queueType: match.queueType,
          eloAtEntry: elo,
          isActive: true,
        },
      });

      queues[match.mode][match.queueType].push({
        id: entry.id,
        userId: uid,
        teamId: null,
        elo,
        joinedAt: Date.now(),
        mode: match.mode,
        queueType: match.queueType,
      });

      broadcastToUser(uid, {
        type: 'REQUEUED',
        data: { mode: match.mode, queueType: match.queueType, message: 'Vous avez été réintégré dans la file.' },
      });
    } catch (err) {
      console.error(`[Matchmaking] Erreur réintégration ${uid}:`, err.message);
    }
  }

  console.log(`[Matchmaking] Match ${match.id} annulé (${reason}). Pénalisés: ${penalizedIds.join(', ')}`);
}

// ─── Boucles ──────────────────────────────────────────────────────────────────

function startMatchmakingLoop() {
  setInterval(async () => {
    for (const mode of ['TWO_V_TWO', 'FIVE_V_FIVE']) {
      for (const type of ['SOLO', 'TEAM']) {
        if (queues[mode][type].length > 0) {
          await tryMatchmaking(mode, type).catch(console.error);
        }
      }
    }
  }, 5000);
  console.log('⚡ Matchmaking loop démarrée (interval: 5s)');
}

async function syncQueueFromDB() {
  try {
    const entries = await prisma.queueEntry.findMany({
      where: { isActive: true },
      include: { user: true },
    });

    for (const entry of entries) {
      const { mode, queueType, eloAtEntry, userId, teamId, joinedAt } = entry;
      if (queues[mode] && queues[mode][queueType]) {
        queues[mode][queueType].push({
          id: entry.id,
          userId,
          teamId,
          elo: eloAtEntry,
          joinedAt: joinedAt.getTime(),
          mode,
          queueType,
        });
      }
    }
    console.log(`[Queue] ${entries.length} entrées synchronisées depuis la DB`);
  } catch (err) {
    console.error('[Queue] Erreur sync DB:', err.message);
  }
}

module.exports = {
  joinQueue, leaveQueue, tryMatchmaking,
  acceptMatch, declineMatch,
  startMatchmakingLoop, syncQueueFromDB,
  getQueues: () => queues,
};
