const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { authRateLimit } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');

/**
 * @route   POST /api/auth/register
 * @desc    Créer un compte
 */
router.post('/register',
  authRateLimit,
  [
    body('username').trim().isLength({ min: 3, max: 20 }).withMessage('Pseudo 3-20 caractères').matches(/^[a-zA-Z0-9_-]+$/).withMessage('Pseudo: lettres, chiffres, _ et - uniquement'),
    body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
    body('password').isLength({ min: 8 }).withMessage('Mot de passe minimum 8 caractères').matches(/(?=.*[A-Z])(?=.*[0-9])/).withMessage('Mot de passe: 1 majuscule et 1 chiffre requis'),
  ],
  validate,
  authController.register,
);

/**
 * @route   POST /api/auth/login
 * @desc    Se connecter
 */
router.post('/login',
  authRateLimit,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  validate,
  authController.login,
);

/**
 * @route   GET /api/auth/me
 * @desc    Profil courant
 */
router.get('/me', authenticate, authController.me);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh token
 */
router.post('/refresh', authenticate, authController.refresh);

module.exports = router;
