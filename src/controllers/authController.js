const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

const register = async (req, res, next) => {
  try {
    const { username, email, password, region } = req.body;

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        region: region || 'EU',
      },
    });

    const token = signToken(user.id);

    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        eloGlobal: user.eloGlobal,
        elo2v2: user.elo2v2,
        elo5v5: user.elo5v5,
        avatarUrl: user.avatarUrl,
        region: user.region,
      },
    });
  } catch (err) {
    next(err);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    if (user.isBanned) {
      const banMsg = user.banExpiresAt
        ? `Compte banni jusqu'au ${user.banExpiresAt.toLocaleDateString()}`
        : 'Compte banni définitivement';
      return res.status(403).json({ error: banMsg });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });

    const token = signToken(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        eloGlobal: user.eloGlobal,
        elo2v2: user.elo2v2,
        elo5v5: user.elo5v5,
        avatarUrl: user.avatarUrl,
        region: user.region,
      },
    });
  } catch (err) {
    next(err);
  }
};

const me = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, username: true, email: true, role: true,
        eloGlobal: true, elo2v2: true, elo5v5: true,
        avatarUrl: true, region: true, preferredRole: true,
        wins: true, losses: true, totalMatches: true,
        winStreak: true, bestStreak: true,
        isBanned: true, banExpiresAt: true,
        createdAt: true, lastActiveAt: true,
        teamMemberships: {
          include: { team: { select: { id: true, name: true, tag: true, avatarUrl: true } } },
        },
        receivedInvitations: {
          where: { status: 'PENDING' },
          include: { team: { select: { id: true, name: true, tag: true } }, sender: { select: { username: true } } },
        },
      },
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
};

const refresh = async (req, res) => {
  const token = signToken(req.user.id);
  res.json({ token });
};

module.exports = { register, login, me, refresh };
