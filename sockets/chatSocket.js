const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { storeEncryptedMessage, formatMessage } = require('../controllers/messageController');

const connectedUsers = new Map();

const attachSocketToUser = (userId, socketId) => {
  const existingSocketIds = connectedUsers.get(userId) || new Set();
  existingSocketIds.add(socketId);
  connectedUsers.set(userId, existingSocketIds);
};

const detachSocketFromUser = (userId, socketId) => {
  const existingSocketIds = connectedUsers.get(userId);

  if (!existingSocketIds) {
    return;
  }

  existingSocketIds.delete(socketId);

  if (existingSocketIds.size === 0) {
    connectedUsers.delete(userId);
  }
};

const emitToUser = (io, userId, eventName, payload) => {
  const socketIds = connectedUsers.get(String(userId));

  if (!socketIds) {
    return;
  }

  socketIds.forEach((socketId) => {
    io.to(socketId).emit(eventName, payload);
  });
};

const registerChatSocket = (io) => {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error('Authentication token is required.'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = String(decoded.id);
      return next();
    } catch (error) {
      return next(new Error('Invalid or expired token.'));
    }
  });

  io.on('connection', (socket) => {
    attachSocketToUser(socket.userId, socket.id);

    socket.on('privateMessage', async (payload = {}) => {
      try {
        const { receiverId, message } = payload;

        if (!receiverId || !mongoose.isValidObjectId(receiverId)) {
          socket.emit('chatError', { message: 'Valid receiverId is required.' });
          return;
        }

        if (String(receiverId) === String(socket.userId)) {
          socket.emit('chatError', { message: 'You cannot send a message to yourself.' });
          return;
        }

        const storedMessage = await storeEncryptedMessage({
          senderId: socket.userId,
          receiverId,
          message,
        });

        const messagePayload = formatMessage(storedMessage.toObject(), socket.userId);

        emitToUser(io, receiverId, 'messageReceived', messagePayload);
        emitToUser(io, socket.userId, 'messageReceived', messagePayload);
      } catch (error) {
        const messageText = error.status ? error.message : 'Unable to deliver message.';
        socket.emit('chatError', { message: messageText });
      }
    });

    socket.on('disconnect', () => {
      detachSocketFromUser(socket.userId, socket.id);
    });
  });
};

module.exports = registerChatSocket;
