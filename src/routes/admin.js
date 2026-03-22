const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.use(authenticate, requireAdmin);

router.get('/dashboard',          adminController.getDashboard);
router.get('/users',              adminController.listUsers);
router.patch('/users/:id/ban',    adminController.banUser);
router.patch('/users/:id/unban',  adminController.unbanUser);
router.get('/disputes',           adminController.listDisputes);
router.patch('/disputes/:id',     adminController.resolveDispute);
router.get('/reports',            adminController.listReports);
router.patch('/reports/:id',      adminController.resolveReport);
router.post('/matches/:id/override', adminController.overrideMatchResult);

module.exports = router;
