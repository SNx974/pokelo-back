const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireAdmin } = require('../middleware/auth');
const prisma = new PrismaClient();

router.get('/', async (req, res, next) => {
  try {
    const news = await prisma.news.findMany({
      where: { isPublished: true },
      include: { author: { select: { id: true, username: true, avatarUrl: true } } },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      take: 20,
    });
    res.json(news);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const news = await prisma.news.findUnique({
      where: { id: req.params.id },
      include: { author: { select: { username: true, avatarUrl: true } } },
    });
    if (!news || !news.isPublished) return res.status(404).json({ error: 'Article introuvable' });
    res.json(news);
  } catch (err) { next(err); }
});

router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { title, content, coverImage, isPinned, isPublished } = req.body;
    const news = await prisma.news.create({
      data: { title, content, coverImage, isPinned: !!isPinned, isPublished: !!isPublished, authorId: req.user.id },
    });
    res.status(201).json(news);
  } catch (err) { next(err); }
});

router.patch('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const news = await prisma.news.update({ where: { id: req.params.id }, data: req.body });
    res.json(news);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    await prisma.news.delete({ where: { id: req.params.id } });
    res.json({ message: 'Article supprimé' });
  } catch (err) { next(err); }
});

module.exports = router;
