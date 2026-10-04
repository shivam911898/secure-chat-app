const express = require('express');
const { getMissedCalls, markSeen } = require('../controllers/callController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/missed', authMiddleware, getMissedCalls);
router.post('/seen', authMiddleware, markSeen);

module.exports = router;
