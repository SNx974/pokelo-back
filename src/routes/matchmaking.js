const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { matchmakingRateLimit } = require('../middleware/rateLimit');
const { joinQueue, leaveQueue, getQueues } = require('../services/matchmakingService');

router.post('/join', authenticate, matchmakingRateLimit, async (req, res, next) => {
  try {
    const { mode, queueType, teamId } = req.body;

    const validModes = ['TWO_V_TWO', 'FIVE_V_FIVE'];
    const validTypes = ['SOLO', 'TEAM'];

    if (!validModes.includes(mode)) return res.status(400).json({ error: 'Mode invalide' });
    if (!validTypes.includes(queueType)) return res.status(400).json({ error: 'Type de queue invalide' });
    if (queueType === 'TEAM' && !teamId) return res.status(400).json({ error: 'teamId requis pour la queue équipe' });

    const entry = await joinQueue(req.user.id, mode, queueType, teamId);
    res.status(201).json({ message: 'Vous êtes dans la file d\'attente', entryId: entry.id, mode, queueType });
  } catch (err) {
    if (err.message.includes('déjà en file')) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/leave', authenticate, async (req, res, next) => {
  try {
    await leaveQueue(req.user.id);
    res.json({ message: 'Vous avez quitté la file d\'attente' });
  } catch (err) { next(err); }
});

router.get('/status', authenticate, async (req, res, next) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const entry = await prisma.queueEntry.findFirst({
      where: { userId: req.user.id, isActive: true },
    });
    res.json({ inQueue: !!entry, entry: entry || null });
  } catch (err) { next(err); }
});

router.get('/info', async (req, res) => {
  const queues = getQueues();
  res.json({
    TWO_V_TWO: {
      SOLO: queues.TWO_V_TWO.SOLO.length,
      TEAM: queues.TWO_V_TWO.TEAM.length,
    },
    FIVE_V_FIVE: {
      SOLO: queues.FIVE_V_FIVE.SOLO.length,
      TEAM: queues.FIVE_V_FIVE.TEAM.length,
    },
  });
});

module.exports = router;
