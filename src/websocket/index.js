const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { registerUser, unregisterUser, joinRoom, leaveRoom } = require('./broadcaster');
const { startMatchmakingLoop, syncQueueFromDB } = require('../services/matchmakingService');
const { startTimeoutLoop } = require('../services/matchTimeoutService');

const prisma = new PrismaClient();

function initWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    let userId = null;
    let heartbeatInterval = null;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'AUTH': {
            try {
              const decoded = jwt.verify(msg.token, process.env.JWT_SECRET);
              const user = await prisma.user.findUnique({
                where: { id: decoded.userId },
                select: { id: true, username: true, role: true, isBanned: true },
              });
              if (!user || user.isBanned) {
                ws.send(JSON.stringify({ type: 'AUTH_ERROR', error: 'Non autorisé' }));
                ws.close();
                return;
              }
              userId = user.id;
              registerUser(userId, ws);

              // Admin room
              if (user.role === 'ADMIN' || user.role === 'MODERATOR') {
                joinRoom('admin', ws);
              }

              // Update last active
              await prisma.user.update({
                where: { id: userId },
                data: { lastActiveAt: new Date() },
              });

              ws.send(JSON.stringify({ type: 'AUTH_OK', userId, username: user.username }));

              // Heartbeat
              heartbeatInterval = setInterval(() => {
                if (!ws.isAlive) { ws.terminate(); return; }
                ws.isAlive = false;
                ws.ping();
              }, 30000);

            } catch {
              ws.send(JSON.stringify({ type: 'AUTH_ERROR', error: 'Token invalide' }));
              ws.close();
            }
            break;
          }

          case 'JOIN_ROOM': {
            if (userId && msg.room) joinRoom(msg.room, ws);
            break;
          }

          case 'LEAVE_ROOM': {
            if (userId && msg.room) leaveRoom(msg.room, ws);
            break;
          }

          case 'PING': {
            ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
            break;
          }

          // Rejoindre la room d'un match (pour recevoir les msgs chat + events)
          case 'JOIN_MATCH': {
            if (userId && msg.matchId) {
              // Vérifie que l'utilisateur est bien participant du match
              const participant = await prisma.matchParticipant.findFirst({
                where: { matchId: msg.matchId, userId },
              });
              if (participant) {
                joinRoom(`match:${msg.matchId}`, ws);
                ws.send(JSON.stringify({ type: 'MATCH_JOINED', matchId: msg.matchId }));
              } else {
                ws.send(JSON.stringify({ type: 'ERROR', error: 'Non participant du match' }));
              }
            }
            break;
          }

          case 'LEAVE_MATCH': {
            if (userId && msg.matchId) {
              leaveRoom(`match:${msg.matchId}`, ws);
            }
            break;
          }

          default:
            ws.send(JSON.stringify({ type: 'ERROR', error: `Type inconnu: ${msg.type}` }));
        }
      } catch (err) {
        console.error('[WS] Parse error:', err.message);
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Message invalide (JSON requis)' }));
      }
    });

    ws.on('close', () => {
      if (userId) unregisterUser(userId, ws);
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    });

    ws.on('error', (err) => {
      console.error('[WS] Erreur connexion:', err.message);
    });

    // Premier message de bienvenue
    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Connecté à Pokélo WS. Envoyez AUTH pour vous authentifier.' }));
  });

  // Lance les boucles
  syncQueueFromDB().then(() => {
    startMatchmakingLoop();
    startTimeoutLoop();
  });

  console.log('🔌 WebSocket server initialisé');
  return wss;
}

module.exports = { initWebSocket };
