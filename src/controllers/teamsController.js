const { PrismaClient } = require('@prisma/client');
const { broadcastToUser } = require('../websocket/broadcaster');

const prisma = new PrismaClient();

const MEMBER_SELECT = {
  include: {
    user: {
      select: {
        id: true, username: true, avatarUrl: true,
        eloGlobal: true, elo2v2: true, elo5v5: true,
        wins: true, losses: true,
      },
    },
  },
  orderBy: { role: 'asc' },
};

const isCaptain = (team, userId) =>
  team.members.some(m => m.userId === userId && m.role === 'CAPTAIN');

// ─── Lecture ──────────────────────────────────────────────────────────────────

const listTeams = async (req, res, next) => {
  try {
    const { q, region, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {
      ...(q      ? { name: { contains: q, mode: 'insensitive' } } : {}),
      ...(region ? { region } : {}),
    };
    const [teams, total] = await Promise.all([
      prisma.team.findMany({
        where, skip, take: parseInt(limit),
        orderBy: { eloTeam: 'desc' },
        include: { members: MEMBER_SELECT },
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
      include: { members: MEMBER_SELECT },
    });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
    res.json(team);
  } catch (err) { next(err); }
};

/**
 * Renvoie l'équipe du joueur connecté (première équipe trouvée).
 */
const getMyTeam = async (req, res, next) => {
  try {
    const membership = await prisma.teamMember.findFirst({
      where: { userId: req.user.id },
      include: {
        team: {
          include: {
            members: MEMBER_SELECT,
            invitations: {
              where: { status: 'PENDING' },
              include: {
                receiver: { select: { id: true, username: true, avatarUrl: true } },
                sender:   { select: { id: true, username: true } },
              },
            },
          },
        },
      },
    });
    res.json({ team: membership ? membership.team : null, role: membership?.role || null });
  } catch (err) { next(err); }
};

/**
 * Renvoie les invitations en attente reçues par le joueur connecté.
 */
const getMyInvitations = async (req, res, next) => {
  try {
    const invitations = await prisma.teamInvitation.findMany({
      where: {
        receiverId: req.user.id,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      include: {
        team:   { select: { id: true, name: true, tag: true, avatarUrl: true, eloTeam: true, region: true } },
        sender: { select: { id: true, username: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(invitations);
  } catch (err) { next(err); }
};

// ─── CRUD ─────────────────────────────────────────────────────────────────────

const createTeam = async (req, res, next) => {
  try {
    const { name, tag, description, region } = req.body;
    const userId = req.user.id;

    const existingCap = await prisma.teamMember.findFirst({ where: { userId, role: 'CAPTAIN' } });
    if (existingCap) return res.status(400).json({ error: 'Vous êtes déjà capitaine d\'une équipe.' });

    const team = await prisma.team.create({
      data: {
        name,
        tag: tag.toUpperCase(),
        description,
        region: region || 'EU',
        members: { create: { userId, role: 'CAPTAIN' } },
      },
      include: { members: MEMBER_SELECT },
    });
    res.status(201).json(team);
  } catch (err) { next(err); }
};

const updateTeam = async (req, res, next) => {
  try {
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
    if (!isCaptain(team, req.user.id)) return res.status(403).json({ error: 'Capitaine requis' });

    const { name, description, region, avatarUrl } = req.body;
    const updated = await prisma.team.update({
      where: { id: req.params.id },
      data: {
        ...(name        !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(region                    && { region }),
        ...(avatarUrl                 && { avatarUrl }),
      },
      include: { members: MEMBER_SELECT },
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
    // Notifie tous les membres
    for (const m of team.members) {
      if (m.userId !== req.user.id) {
        broadcastToUser(m.userId, { type: 'TEAM_DISSOLVED', data: { teamName: team.name } });
      }
    }
    await prisma.team.delete({ where: { id: req.params.id } });
    res.json({ message: 'Équipe supprimée' });
  } catch (err) { next(err); }
};

// ─── Membres & invitations ────────────────────────────────────────────────────

const invitePlayer = async (req, res, next) => {
  try {
    const { targetUserId, targetUsername } = req.body;

    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
    if (!isCaptain(team, req.user.id)) return res.status(403).json({ error: 'Capitaine requis' });

    // Résolution du joueur cible : par ID ou par pseudo
    let targetId = targetUserId;
    if (!targetId && targetUsername) {
      const found = await prisma.user.findFirst({
        where: { username: { equals: targetUsername, mode: 'insensitive' } },
        select: { id: true },
      });
      if (!found) return res.status(404).json({ error: 'Joueur introuvable' });
      targetId = found.id;
    }
    if (!targetId) return res.status(400).json({ error: 'targetUserId ou targetUsername requis' });

    if (team.members.some(m => m.userId === targetId)) {
      return res.status(400).json({ error: 'Joueur déjà dans l\'équipe' });
    }

    const pending = await prisma.teamInvitation.findFirst({
      where: { teamId: team.id, receiverId: targetId, status: 'PENDING' },
    });
    if (pending) return res.status(400).json({ error: 'Invitation déjà envoyée' });

    const invitation = await prisma.teamInvitation.create({
      data: {
        teamId: team.id,
        senderId: req.user.id,
        receiverId: targetId,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
      include: {
        team:   { select: { name: true, tag: true } },
        sender: { select: { username: true } },
      },
    });

    // Notifie le joueur invité via WS
    broadcastToUser(targetId, {
      type: 'TEAM_INVITATION',
      data: {
        invitationId: invitation.id,
        teamName:     invitation.team.name,
        teamTag:      invitation.team.tag,
        senderName:   invitation.sender.username,
      },
    });

    res.status(201).json(invitation);
  } catch (err) { next(err); }
};

const cancelInvitation = async (req, res, next) => {
  try {
    const inv = await prisma.teamInvitation.findUnique({ where: { id: req.params.invitationId } });
    if (!inv) return res.status(404).json({ error: 'Invitation introuvable' });

    const team = await prisma.team.findUnique({ where: { id: inv.teamId }, include: { members: true } });
    if (!isCaptain(team, req.user.id)) return res.status(403).json({ error: 'Capitaine requis' });

    await prisma.teamInvitation.update({ where: { id: inv.id }, data: { status: 'REFUSED' } });
    res.json({ message: 'Invitation annulée' });
  } catch (err) { next(err); }
};

const kickMember = async (req, res, next) => {
  try {
    const { targetUserId } = req.body;
    const team = await prisma.team.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!team) return res.status(404).json({ error: 'Équipe introuvable' });
    if (!isCaptain(team, req.user.id)) return res.status(403).json({ error: 'Capitaine requis' });
    if (targetUserId === req.user.id) return res.status(400).json({ error: 'Impossible de se kick soi-même' });

    await prisma.teamMember.deleteMany({ where: { teamId: team.id, userId: targetUserId } });

    broadcastToUser(targetUserId, { type: 'TEAM_KICKED', data: { teamName: team.name } });
    res.json({ message: 'Joueur retiré de l\'équipe' });
  } catch (err) { next(err); }
};

const leaveTeam = async (req, res, next) => {
  try {
    const membership = await prisma.teamMember.findFirst({ where: { teamId: req.params.id, userId: req.user.id } });
    if (!membership) return res.status(404).json({ error: 'Vous n\'êtes pas dans cette équipe' });
    if (membership.role === 'CAPTAIN') {
      return res.status(400).json({ error: 'Le capitaine ne peut pas quitter l\'équipe. Transférez la capitainerie ou dissolvez l\'équipe.' });
    }

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

    // Notifie le capitaine
    const team = await prisma.team.findUnique({ where: { id: inv.teamId }, include: { members: true } });
    const cap = team?.members.find(m => m.role === 'CAPTAIN');
    if (cap) {
      broadcastToUser(cap.userId, {
        type: 'TEAM_INVITE_ACCEPTED',
        data: { username: req.user.username, teamName: team.name },
      });
    }

    res.json({ message: 'Invitation acceptée', teamId: inv.teamId });
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

module.exports = {
  listTeams, getTeam, getMyTeam, getMyInvitations,
  createTeam, updateTeam, deleteTeam,
  invitePlayer, cancelInvitation, kickMember, leaveTeam,
  acceptInvitation, declineInvitation,
};
