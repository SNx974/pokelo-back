const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const isCaptain = (team, userId) =>
  team.members.some(m => m.userId === userId && m.role === 'CAPTAIN');

const listTeams = async (req, res, next) => {
  try {
    const { q, region, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      ...(region ? { region } : {}),
    };
    const [teams, total] = await Promise.all([
      prisma.team.findMany({
        where, skip, take: parseInt(limit),
        orderBy: { eloTeam: 'desc' },
        include: { members: { include: { user: { select: { id: true, username: true, avatarUrl: true } } } } },
      }),
      prisma.team.count({ where }),
    ]);
    res.json({ teams, total, page: parseInt(page) });
  } catch (err) { next(err); }
};

const getTeam = async (req, res, next) => {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: {
        members: {
          include: { user: { select: { id: true, username: true, avatarUrl: true, eloGlobal: true, elo2v2: true, elo5v5: true, wins: true, losses: true } } },
          orderBy: { role: 'asc' },
        },
      },
    });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
    res.json(team);
  } catch (err) { next(err); }
};

const createTeam = async (req, res, next) => {
  try {
    const { name, tag, description, region } = req.body;
    const userId = req.user.id;

    // Un joueur ne peut être capitaine que d'une seule équipe
    const existingCap = await prisma.teamMember.findFirst({
      where: { userId, role: 'CAPTAIN' },
    });
    if (existingCap) return res.status(400).json({ error: 'Vous êtes déjà capitaine d\'une équipe.' });

    const team = await prisma.team.create({
      data: {
        name, tag: tag.toUpperCase(), description, region: region || 'EU',
        members: { create: { userId, role: 'CAPTAIN' } },
      },
      include: { members: { include: { user: { select: { id: true, username: true } } } } },
    });
    res.status(201).json(team);
  } catch (err) { next(err); }
};

const updateTeam = async (req, res, next) => {
  try {
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
    if (!isCaptain(team, req.user.id)) return res.status(403).json({ error: 'Capitaine requis' });

    const { description, region, avatarUrl } = req.body;
    const updated = await prisma.team.update({
      where: { id: req.params.id },
      data: { ...(description !== undefined && { description }), ...(region && { region }), ...(avatarUrl && { avatarUrl }) },
    });
    res.json(updated);
  } catch (err) { next(err); }
};

const deleteTeam = async (req, res, next) => {
  try {
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
    if (!isCaptain(team, req.user.id) && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Capitaine ou admin requis' });
    }
    await prisma.team.delete({ where: { id: req.params.id } });
    res.json({ message: 'Équipe supprimée' });
  } catch (err) { next(err); }
};

const invitePlayer = async (req, res, next) => {
  try {
    const { targetUserId } = req.body;
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
    if (!isCaptain(team, req.user.id)) return res.status(403).json({ error: 'Capitaine requis' });
    if (team.members.some(m => m.userId === targetUserId)) return res.status(400).json({ error: 'Joueur déjà dans l\'équipe' });

    const pending = await prisma.teamInvitation.findFirst({
      where: { teamId: team.id, receiverId: targetUserId, status: 'PENDING' },
    });
    if (pending) return res.status(400).json({ error: 'Invitation déjà envoyée' });

    const invitation = await prisma.teamInvitation.create({
      data: {
        teamId: team.id,
        senderId: req.user.id,
        receiverId: targetUserId,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
      include: { team: { select: { name: true, tag: true } }, sender: { select: { username: true } } },
    });
    res.status(201).json(invitation);
  } catch (err) { next(err); }
};

const kickMember = async (req, res, next) => {
  try {
    const { targetUserId } = req.body;
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
    if (!isCaptain(team, req.user.id)) return res.status(403).json({ error: 'Capitaine requis' });
    if (targetUserId === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas vous kick vous-même' });

    await prisma.teamMember.deleteMany({ where: { teamId: team.id, userId: targetUserId } });
    res.json({ message: 'Joueur retiré de l\'équipe' });
  } catch (err) { next(err); }
};

const leaveTeam = async (req, res, next) => {
  try {
    const membership = await prisma.teamMember.findFirst({
      where: { teamId: req.params.id, userId: req.user.id },
    });
    if (!membership) return res.status(404).json({ error: 'Vous n\'êtes pas dans cette équipe' });
    if (membership.role === 'CAPTAIN') return res.status(400).json({ error: 'Le capitaine ne peut pas quitter l\'équipe. Transférez la capitainerie ou supprimez l\'équipe.' });

    await prisma.teamMember.delete({ where: { id: membership.id } });
    res.json({ message: 'Vous avez quitté l\'équipe' });
  } catch (err) { next(err); }
};

const acceptInvitation = async (req, res, next) => {
  try {
    const inv = await prisma.teamInvitation.findUnique({ where: { id: req.params.invitationId } });
    if (!inv || inv.receiverId !== req.user.id) return res.status(404).json({ error: 'Invitation introuvable' });
    if (inv.status !== 'PENDING') return res.status(400).json({ error: 'Invitation déjà traitée' });
    if (inv.expiresAt < new Date()) {
      await prisma.teamInvitation.update({ where: { id: inv.id }, data: { status: 'EXPIRED' } });
      return res.status(400).json({ error: 'Invitation expirée' });
    }

    await prisma.$transaction([
      prisma.teamInvitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED' } }),
      prisma.teamMember.create({ data: { userId: req.user.id, teamId: inv.teamId, role: 'MEMBER' } }),
    ]);

    res.json({ message: 'Invitation acceptée' });
  } catch (err) { next(err); }
};

const declineInvitation = async (req, res, next) => {
  try {
    const inv = await prisma.teamInvitation.findUnique({ where: { id: req.params.invitationId } });
    if (!inv || inv.receiverId !== req.user.id) return res.status(404).json({ error: 'Invitation introuvable' });

    await prisma.teamInvitation.update({ where: { id: inv.id }, data: { status: 'REFUSED' } });
    res.json({ message: 'Invitation refusée' });
  } catch (err) { next(err); }
};

module.exports = { listTeams, getTeam, createTeam, updateTeam, deleteTeam, invitePlayer, kickMember, leaveTeam, acceptInvitation, declineInvitation };
