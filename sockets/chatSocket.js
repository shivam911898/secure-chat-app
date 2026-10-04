const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Call = require('../models/Call');
const Message = require('../models/Message');
const { encryptText } = require('../utils/encryption');
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
    // and call control between the two peers, and record the lifecycle so an
    // unanswered call can surface as a missed call for the callee.
    const relayCallEvent = (clientEvent, serverEvent, onRelay) => {
      socket.on(clientEvent, async (payload = {}) => {
        const { to } = payload;

        if (!to || !mongoose.isValidObjectId(to) || String(to) === String(socket.userId)) {
          return;
        }

        // Record first, relay second: a callee can hang up the instant the
        // invite reaches them, and the call row must already exist by then.
        if (onRelay) {
          try {
            await onRelay(payload);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Failed to record call event:', error);
          }
        }

        emitToUser(io, to, serverEvent, { ...payload, from: socket.userId });
      });
    };

    relayCallEvent('call:invite', 'call:invite', async (payload) => {
      if (!payload.callId) {
        return;
      }

      await Call.create({
        callId: String(payload.callId),
        caller: socket.userId,
        callee: payload.to,
        status: 'ringing',
        startedAt: new Date(),
      });
    });

    relayCallEvent('call:accept', 'call:accept', async (payload) => {
      if (!payload.callId) {
        return;
      }

      await Call.updateOne(
        { callId: String(payload.callId), callee: socket.userId },
        { $set: { status: 'answered', answeredAt: new Date() } },
      );
    });

    relayCallEvent('call:reject', 'call:reject', async (payload) => {
      if (!payload.callId) {
        return;
      }

      await Call.updateOne(
        { callId: String(payload.callId), callee: socket.userId, status: 'ringing' },
        { $set: { status: 'declined', endedAt: new Date() } },
      );
    });

    relayCallEvent('call:hangup', 'call:hangup', async (payload) => {
      if (!payload.callId) {
        return;
      }

      // The invite insert and this update are two separate awaits, so a very
      // fast hang-up can land first; retry briefly instead of dropping it.
      let call = null;

      for (let attempt = 0; attempt < 3 && !call; attempt += 1) {
        call = await Call.findOne({ callId: String(payload.callId) });

        if (!call) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      if (!call) {
        return;
      }

      if (call.status === 'ringing') {
        // Never answered: record it and tell the callee about the missed call.
        await Call.updateOne({ _id: call._id }, { $set: { status: 'missed', endedAt: new Date() } });
        emitToUser(io, String(call.callee), 'callMissed', {
          from: String(call.caller),
          at: call.startedAt,
        });
      } else if (call.status === 'answered') {
        await Call.updateOne({ _id: call._id }, { $set: { status: 'completed', endedAt: new Date() } });
      }
    });

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

    // Editing happens over the socket so both sides see the change immediately.
    socket.on('editMessage', async (payload = {}) => {
      try {
        const { messageId, text } = payload;

        if (!messageId || !mongoose.isValidObjectId(messageId)) {
          socket.emit('chatError', { message: 'Valid message id is required.' });
          return;
        }
        if (typeof text !== 'string' || !text.trim()) {
          socket.emit('chatError', { message: 'Message cannot be empty.' });
          return;
        }

        const target = await Message.findById(messageId);
        if (!target) {
          socket.emit('chatError', { message: 'Message not found.' });
          return;
        }
        if (String(target.sender) !== String(socket.userId)) {
          socket.emit('chatError', { message: 'You can only edit your own messages.' });
          return;
        }

        const encrypted = encryptText(text.trim());
        target.encryptedMessage = encrypted.encryptedMessage;
        target.iv = encrypted.iv;
        target.authTag = encrypted.authTag;
        target.editedAt = new Date();
        await target.save();

        const doc = target.toObject();
        emitToUser(io, target.sender, 'messageEdited', formatMessage(doc, String(target.sender)));
        emitToUser(io, target.receiver, 'messageEdited', formatMessage(doc, String(target.receiver)));
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to edit message:', error);
        socket.emit('chatError', { message: 'Unable to edit message.' });
      }
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
        const { receiverId, message, attachment, replyTo } = payload;

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
          attachment,
          replyTo,
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
