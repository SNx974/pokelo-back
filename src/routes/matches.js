const express = require('express');
const router = express.Router();
const matchesController = require('../controllers/matchesController');
const { authenticate } = require('../middleware/auth');

router.get('/',                     matchesController.listMatches);
router.get('/active',               authenticate, matchesController.getActiveMatch);
router.get('/:id',                  matchesController.getMatch);
router.post('/:id/result',          authenticate, matchesController.submitResult);
router.post('/:id/dispute',         authenticate, matchesController.createDispute);
router.post('/:id/report',          authenticate, matchesController.reportMatch);
router.get('/:id/chat',             authenticate, matchesController.getChatMessages);
router.post('/:id/chat',            authenticate, matchesController.sendChatMessage);

module.exports = router;
