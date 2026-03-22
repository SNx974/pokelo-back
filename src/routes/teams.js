const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const teamsController = require('../controllers/teamsController');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

// ─── Lecture ──────────────────────────────────────────────────────────────────
router.get('/',     optionalAuth, teamsController.listTeams);
// /my avant /:id pour éviter le conflit de route
router.get('/my',   authenticate, teamsController.getMyTeam);
router.get('/:id',              optionalAuth, teamsController.getTeam);
router.get('/:id/online-status', authenticate, teamsController.getTeamOnlineStatus);

// ─── CRUD ─────────────────────────────────────────────────────────────────────
router.post('/',
  authenticate,
  [
    body('name').trim().isLength({ min: 3, max: 30 }).withMessage('Nom 3-30 caractères'),
    body('tag').trim().isLength({ min: 2, max: 5 }).withMessage('Tag 2-5 caractères').matches(/^[a-zA-Z0-9]+$/),
    body('description').optional().trim().isLength({ max: 200 }),
    body('region').optional().isIn(['EU', 'NA', 'ASIA', 'OCE', 'SA']),
  ],
  validate,
  teamsController.createTeam,
);
router.patch('/:id',   authenticate, teamsController.updateTeam);
router.delete('/:id',  authenticate, teamsController.deleteTeam);

// ─── Membres ──────────────────────────────────────────────────────────────────
router.post('/:id/invite', authenticate, teamsController.invitePlayer);
router.post('/:id/kick',   authenticate, teamsController.kickMember);
router.post('/:id/leave',  authenticate, teamsController.leaveTeam);

// ─── Invitations ──────────────────────────────────────────────────────────────
router.get('/invitations/my',                             authenticate, teamsController.getMyInvitations);
router.post('/invitations/:invitationId/cancel',          authenticate, teamsController.cancelInvitation);
router.post('/invitations/:invitationId/accept',          authenticate, teamsController.acceptInvitation);
router.post('/invitations/:invitationId/decline',         authenticate, teamsController.declineInvitation);

module.exports = router;
