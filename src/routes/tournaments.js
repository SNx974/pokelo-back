const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireAdmin } = require('../middleware/auth');
const prisma = new PrismaClient();

router.get('/', async (req, res, next) => {
  try {
    const tournaments = await prisma.tournament.findMany({ orderBy: { startDate: 'asc' } });
    res.json(tournaments);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const t = await prisma.tournament.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Tournoi introuvable' });
    res.json(t);
  } catch (err) { next(err); }
});

router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const t = await prisma.tournament.create({ data: req.body });
    res.status(201).json(t);
  } catch (err) { next(err); }
});

router.patch('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const t = await prisma.tournament.update({ where: { id: req.params.id }, data: req.body });
    res.json(t);
  } catch (err) { next(err); }
});

module.exports = router;
