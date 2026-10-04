const mongoose = require('mongoose');
const Message = require('../models/Message');
const User = require('../models/User');
const { encryptText, decryptText } = require('../utils/encryption');

const validateMessagePayload = (senderId, receiverId, message) => {
  if (!receiverId || !mongoose.isValidObjectId(receiverId)) {
    return 'Valid receiverId is required.';
  }

  if (typeof message !== 'string' || !message.trim()) {
    return 'Message cannot be empty.';
  }

  if (senderId === receiverId) {
    return 'You cannot send a message to yourself.';
  }

  return null;
};

const storeEncryptedMessage = async ({ senderId, receiverId, message }) => {
  const payloadError = validateMessagePayload(senderId, receiverId, message);

  if (payloadError) {
    const error = new Error(payloadError);
    error.status = 400;
    throw error;
  }

  const receiverObjectId = new mongoose.Types.ObjectId(receiverId);
  const receiverExists = await User.exists({ _id: receiverObjectId });

  if (!receiverExists) {
    const error = new Error('Receiver not found.');
    error.status = 404;
    throw error;
  }

  const encrypted = encryptText(message.trim());

  const stored = await Message.create({
    sender: senderId,
    receiver: receiverObjectId,
    encryptedMessage: encrypted.encryptedMessage,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    status: 'sent',
  });

  return stored;
};

// Returns the ids of messages that just moved to "delivered" (receiver online).
const markMessagesDelivered = async ({ viewerId }) => {
  const viewer = new mongoose.Types.ObjectId(viewerId);
  // `$in: [null]` also matches documents written before the `status` field existed.
  const pending = await Message.find({
    receiver: viewer,
    status: { $in: ['sent', null] },
  }).select('_id sender');

  if (!pending.length) {
    return { messageIds: [], senderIds: [] };
  }

  const messageIds = pending.map((message) => message._id);
  await Message.updateMany({ _id: { $in: messageIds } }, { $set: { status: 'delivered' } });

  const senderIds = [...new Set(pending.map((message) => String(message.sender)))];
  return { messageIds, senderIds };
};

// Returns the ids of messages that just moved to "seen" (viewer opened the chat).
const markMessagesSeen = async ({ viewerId, otherUserId }) => {
  const viewer = new mongoose.Types.ObjectId(viewerId);
  const other = new mongoose.Types.ObjectId(otherUserId);
  const pending = await Message.find({
    sender: other,
    receiver: viewer,
    status: { $ne: 'seen' },
  }).select('_id');

  if (!pending.length) {
    return [];
  }

  const messageIds = pending.map((message) => message._id);
  await Message.updateMany({ _id: { $in: messageIds } }, { $set: { status: 'seen' } });
  return messageIds;
};

const formatMessage = (messageDoc, currentUserId) => ({
  id: messageDoc._id,
  sender: messageDoc.sender,
  receiver: messageDoc.receiver,
  message: decryptText({
    encryptedMessage: messageDoc.encryptedMessage,
    iv: messageDoc.iv,
    authTag: messageDoc.authTag,
  }),    timestamp: messageDoc.createdAt,
    status: messageDoc.status || 'sent',
    isOwnMessage: String(messageDoc.sender) === String(currentUserId),
});

const getConversation = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid user ID.' });
    }

    const otherUserId = new mongoose.Types.ObjectId(userId);
    const currentUserId = new mongoose.Types.ObjectId(req.user.id);
    const otherUser = await User.findById(otherUserId).select('_id');

    if (!otherUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const messages = await Message.find({
      $or: [
        { sender: currentUserId, receiver: otherUserId },
        { sender: otherUserId, receiver: currentUserId },
      ],
    })
      .sort({ createdAt: 1 })
      .lean();

    const decrypted = messages.map((message) => formatMessage(message, req.user.id));
    return res.status(200).json(decrypted);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to fetch conversation:', error);
    return res.status(500).json({ message: 'Unable to fetch messages.' });
  }
};

const sendMessage = async (req, res) => {
  try {
    const { receiverId, message } = req.body;

    const stored = await storeEncryptedMessage({
      senderId: req.user.id,
      receiverId,
      message,
    });

    const responseMessage = formatMessage(stored.toObject(), req.user.id);

    return res.status(201).json(responseMessage);
  } catch (error) {
    const status = error.status || 500;

    if (status === 500) {
      // eslint-disable-next-line no-console
      console.error('Failed to send message:', error);
    }

    const message = status === 500 ? 'Unable to send message.' : error.message;
    return res.status(status).json({ message });
  }
};

module.exports = {
  getConversation,
  sendMessage,
  storeEncryptedMessage,
  formatMessage,
  markMessagesDelivered,
  markMessagesSeen,
};
