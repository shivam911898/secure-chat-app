const express = require('express');
const {
  getConversation,
  searchMessages,
  sendMessage,
  getAttachment,
} = require('../controllers/messageController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/:userId/search', authMiddleware, searchMessages);
router.get('/:userId', authMiddleware, getConversation);
router.get('/:messageId/attachment', authMiddleware, getAttachment);
router.post('/', authMiddleware, sendMessage);

module.exports = router;
