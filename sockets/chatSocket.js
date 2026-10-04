const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const {
  storeEncryptedMessage,
  formatMessage,
  markMessagesDelivered,
  markMessagesSeen,
} = require('../controllers/messageController');

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

const isOnline = (userId) => connectedUsers.has(String(userId));

const broadcastPresence = (io, userId, online) => {
  io.emit('presenceUpdate', { userId: String(userId), online });
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

    socket.emit('presenceSnapshot', [...connectedUsers.keys()]);
    broadcastPresence(io, socket.userId, true);

    socket.on('typing', (payload = {}) => {
      const { receiverId } = payload;

      if (
        !receiverId ||
        !mongoose.isValidObjectId(receiverId) ||
        String(receiverId) === String(socket.userId)
      ) {
        return;
      }

      emitToUser(io, receiverId, 'typing', {
        userId: socket.userId,
        isTyping: payload.isTyping !== false,
      });
    });

    // WebRTC needs a signalling channel: we relay offers, answers, ICE candidates
    // and call control between the two peers without inspecting their payload.
    const relayCallEvent = (clientEvent, serverEvent) => {
      socket.on(clientEvent, (payload = {}) => {
        const { to } = payload;

        if (!to || !mongoose.isValidObjectId(to) || String(to) === String(socket.userId)) {
          return;
        }

        emitToUser(io, to, serverEvent, { ...payload, from: socket.userId });
      });
    };

    relayCallEvent('call:invite', 'call:invite');
    relayCallEvent('call:accept', 'call:accept');
    relayCallEvent('call:reject', 'call:reject');
    relayCallEvent('call:hangup', 'call:hangup');
    relayCallEvent('call:signal', 'call:signal');

    // Anything that was only "sent" while this user was offline is now delivered.
    markMessagesDelivered({ viewerId: socket.userId })
      .then(({ messageIds, senderIds }) => {
        if (!messageIds.length) {
          return;
        }

        senderIds.forEach((senderId) => {
          emitToUser(io, senderId, 'messageStatus', { messageIds, status: 'delivered' });
        });
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error('Failed to mark pending messages as delivered:', error);
      });

    socket.on('conversationOpened', async (payload = {}) => {
      try {
        const { userId } = payload;

        if (!userId || !mongoose.isValidObjectId(userId)) {
          return;
        }

        const messageIds = await markMessagesSeen({
          viewerId: socket.userId,
          otherUserId: userId,
        });

        if (messageIds.length) {
          emitToUser(io, userId, 'messageStatus', { messageIds, status: 'seen' });
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to mark conversation as seen:', error);
      }
    });

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

        const messageDoc = storedMessage.toObject();

        // Receiver is online -> flush everything pending for them (incl. this message)
        // to "delivered" and tell each sender about the new status.
        if (connectedUsers.has(String(receiverId))) {
          const { messageIds, senderIds } = await markMessagesDelivered({ viewerId: receiverId });

          if (messageIds.some((id) => String(id) === String(messageDoc._id))) {
            messageDoc.status = 'delivered';
          }

          senderIds.forEach((senderId) => {
            emitToUser(io, senderId, 'messageStatus', { messageIds, status: 'delivered' });
          });
        }

        // Each recipient needs its own copy so isOwnMessage is correct for both sides.
        emitToUser(io, receiverId, 'messageReceived', formatMessage(messageDoc, receiverId));
        emitToUser(io, socket.userId, 'messageReceived', formatMessage(messageDoc, socket.userId));
      } catch (error) {
        if (error.status) {
          socket.emit('chatError', { message: error.message });
          return;
        }

        // Unexpected failure (bad config, DB error, ...): log the real cause here,
        // keep the client-facing text generic so internals are not exposed.
        // eslint-disable-next-line no-console
        console.error('Failed to deliver message:', error);
        socket.emit('chatError', { message: 'Unable to deliver message.' });
      }
    });

    socket.on('disconnect', () => {
      detachSocketFromUser(socket.userId, socket.id);

      if (!isOnline(socket.userId)) {
        broadcastPresence(io, socket.userId, false);
      }
    });
  });
};

module.exports = registerChatSocket;
