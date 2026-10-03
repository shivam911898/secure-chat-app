const express = require('express');
const { getConversation, sendMessage } = require('../controllers/messageController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/:userId', authMiddleware, getConversation);
router.post('/', authMiddleware, sendMessage);

module.exports = router;
