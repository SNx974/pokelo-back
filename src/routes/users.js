const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const usersController = require('../controllers/usersController');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { validate } = require('../middleware/validate');

router.get('/',              optionalAuth, usersController.search);
router.get('/:id',           optionalAuth, usersController.getProfile);
router.get('/:id/matches',   optionalAuth, usersController.getMatchHistory);
router.get('/:id/elo-history', optionalAuth, usersController.getEloHistory);

router.patch('/me/profile',
  authenticate,
  [
    body('username').optional().trim().isLength({ min: 3, max: 20 }),
    body('region').optional().isIn(['EU', 'NA', 'ASIA', 'OCE', 'SA']),
    body('preferredRole').optional().trim().isLength({ max: 30 }),
  ],
  validate,
  usersController.updateProfile,
);

router.post('/me/avatar', authenticate, upload.single('avatar'), usersController.uploadAvatar);

module.exports = router;
