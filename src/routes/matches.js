const express = require('express');
const router = express.Router();
const matchesController = require('../controllers/matchesController');
const { authenticate } = require('../middleware/auth');

router.get('/',         matchesController.listMatches);
router.get('/:id',      matchesController.getMatch);
router.post('/:id/result',  authenticate, matchesController.submitResult);
router.post('/:id/dispute', authenticate, matchesController.createDispute);
router.post('/:id/report',  authenticate, matchesController.reportMatch);

module.exports = router;
