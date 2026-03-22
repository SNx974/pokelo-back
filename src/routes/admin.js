const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.use(authenticate, requireAdmin);

// Dashboard
router.get('/dashboard',                   adminController.getDashboard);

// Utilisateurs
router.get('/users',                       adminController.listUsers);
router.patch('/users/:id/ban',             adminController.banUser);
router.patch('/users/:id/unban',           adminController.unbanUser);
router.patch('/users/:id/role',            adminController.updateUserRole);

// Litiges
router.get('/disputes',                    adminController.listDisputes);
router.patch('/disputes/:id',              adminController.resolveDispute);

// Signalements
router.get('/reports',                     adminController.listReports);
router.patch('/reports/:id',               adminController.resolveReport);

// Matchs
router.post('/matches/:id/override',       adminController.overrideMatchResult);

// News
router.get('/news',                        adminController.listAllNews);
router.post('/news',                       adminController.createNews);
router.patch('/news/:id',                  adminController.updateNews);
router.delete('/news/:id',                 adminController.deleteNews);

module.exports = router;
