const express = require('express');
const router = express.Router();

router.use('/auth',        require('./auth'));
router.use('/users',       require('./users'));
router.use('/teams',       require('./teams'));
router.use('/matches',     require('./matches'));
router.use('/matchmaking', require('./matchmaking'));
router.use('/ladder',      require('./ladder'));
router.use('/admin',       require('./admin'));
router.use('/news',        require('./news'));
router.use('/tournaments', require('./tournaments'));

module.exports = router;
