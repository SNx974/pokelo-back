const express = require('express');
const router = express.Router();
const ladderController = require('../controllers/ladderController');

router.get('/players', ladderController.getPlayersLadder);
router.get('/teams',   ladderController.getTeamsLadder);
router.get('/stats',   ladderController.getGlobalStats);

module.exports = router;
