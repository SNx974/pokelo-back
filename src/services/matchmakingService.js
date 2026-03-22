/**
 * Pokélo — Matchmaking Service
 * File d'attente intelligente basée sur Elo + temps d'attente
 */

const { PrismaClient } = require('@prisma/client');
const { broadcastToUser, broadcastToRoom } = require('../websocket/broadcaster');

const prisma = new PrismaClient();

// État en mémoire des files (complété par la DB)
const queues = {
  TWO_V_TWO: { SOLO: [], TEAM: [] },
  FIVE_V_FIVE: { SOLO: [], TEAM: [] },
};

const TEAM_SIZES = { TWO_V_TWO: 2, FIVE_V_FIVE: 5 };
const BASE_ELO_RANGE = 150;       // Range initiale
const ELO_EXPAND_PER_30S = 50;   // Expansion toutes les 30s
const MAX_ELO_RANGE = 600;

/**
 * Calcule la tolérance Elo selon le temps d'attente.
 */
function getEloTolerance(waitSeconds) {
  const expansions = Math.floor(waitSeconds / 30);
  return Math.min(BASE_ELO_RANGE + expansions * ELO_EXPAND_PER_30S, MAX_ELO_RANGE);
}

/**
 * Ajoute un joueur/équipe à la file.
 */
async function joinQueue(userId, mode, queueType, teamId = null) {
  // Vérifie si déjà en queue
  const existing = await prisma.queueEntry.findFirst({
    where: { userId, isActive: true },
  });
  if (existing) throw new Error('Vous êtes déjà en file d\'attente.');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('Utilisateur introuvable.');

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

  // Ajoute à la file mémoire
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

  // Notifie le joueur
  broadcastToUser(userId, { type: 'QUEUE_JOINED', data: { mode, queueType, elo } });

  // Tente le matchmaking
  await tryMatchmaking(mode, queueType);

  return entry;
}

/**
 * Retire un joueur de la file.
 */
async function leaveQueue(userId) {
  await prisma.queueEntry.updateMany({
    where: { userId, isActive: true },
    data: { isActive: false },
  });

  for (const mode of ['TWO_V_TWO', 'FIVE_V_FIVE']) {
    for (const type of ['SOLO', 'TEAM']) {
      queues[mode][type] = queues[mode][type].filter(e => e.userId !== userId);
    }
  }

  broadcastToUser(userId, { type: 'QUEUE_LEFT' });
}

/**
 * Cœur du matchmaking — trouve des équipes compatibles.
 */
async function tryMatchmaking(mode, queueType) {
  const teamSize = TEAM_SIZES[mode];
  const queue = queues[mode][queueType];

  if (queueType === 'SOLO') {
    if (queue.length < teamSize * 2) return;

    // Tri par Elo
    queue.sort((a, b) => a.elo - b.elo);

    // Fenêtre glissante pour trouver 2*teamSize joueurs compatibles
    for (let i = 0; i <= queue.length - teamSize * 2; i++) {
      const group = queue.slice(i, i + teamSize * 2);
      const now = Date.now();
      const minElo = group[0].elo;
      const maxElo = group[group.length - 1].elo;

      const maxTolerance = Math.max(
        ...group.map(e => getEloTolerance((now - e.joinedAt) / 1000))
      );

      if (maxElo - minElo <= maxTolerance) {
        // Match trouvé !
        const team1 = group.slice(0, teamSize);
        const team2 = group.slice(teamSize, teamSize * 2);
        await createMatch(team1, team2, mode, queueType);

        // Retire les joueurs de la file
        const matchedIds = group.map(e => e.userId).filter(Boolean);
        queues[mode][queueType] = queue.filter(e => !matchedIds.includes(e.userId));
        break;
      }
    }
  }
}

/**
 * Crée un match en DB et notifie les joueurs.
 */
async function createMatch(team1Entries, team2Entries, mode, queueType) {
  const match = await prisma.match.create({
    data: {
      mode,
      queueType,
      status: 'IN_PROGRESS',
      startedAt: new Date(),
      participants: {
        create: [
          ...team1Entries.map(e => ({
            userId: e.userId,
            team: 1,
            eloBefore: e.elo,
          })),
          ...team2Entries.map(e => ({
            userId: e.userId,
            team: 2,
            eloBefore: e.elo,
          })),
        ],
      },
    },
    include: { participants: { include: { user: { select: { id: true, username: true, avatarUrl: true } } } } },
  });

  // Désactive les entrées de queue en DB
  const allUserIds = [...team1Entries, ...team2Entries].map(e => e.userId).filter(Boolean);
  await prisma.queueEntry.updateMany({
    where: { userId: { in: allUserIds }, isActive: true },
    data: { isActive: false },
  });

  // Notifie tous les joueurs du match trouvé
  const matchData = {
    type: 'MATCH_FOUND',
    data: {
      matchId: match.id,
      mode,
      queueType,
      team1: team1Entries.map(e => ({ userId: e.userId, elo: e.elo })),
      team2: team2Entries.map(e => ({ userId: e.userId, elo: e.elo })),
    },
  };

  for (const entry of [...team1Entries, ...team2Entries]) {
    if (entry.userId) broadcastToUser(entry.userId, matchData);
  }

  broadcastToRoom('admin', { type: 'MATCH_CREATED', data: { matchId: match.id, mode } });

  console.log(`[Matchmaking] Match créé: ${match.id} (${mode} ${queueType})`);
  return match;
}

/**
 * Boucle de matchmaking — vérifie toutes les 5 secondes.
 */
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

/**
 * Synchronise la file mémoire avec la DB au démarrage.
 */
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

module.exports = { joinQueue, leaveQueue, tryMatchmaking, startMatchmakingLoop, syncQueueFromDB, getQueues: () => queues };
