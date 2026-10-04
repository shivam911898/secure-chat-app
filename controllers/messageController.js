const mongoose = require('mongoose');
const Message = require('../models/Message');
const User = require('../models/User');
const { encryptText, decryptText, encryptBuffer, decryptBuffer } = require('../utils/encryption');

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_NAME = 120;

const sanitizeFileName = (name) => {
  const base = String(name || 'attachment').split(/[\\/]/).pop().replace(/"/g, '');
  return base.slice(0, MAX_ATTACHMENT_NAME) || 'attachment';
};

// Accepts raw base64 or a data URL; returns the bytes, or null when malformed.
const decodeBase64 = (value) => {
  const raw = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    return null;
  }

  const buffer = Buffer.from(raw, 'base64');
  return buffer.length ? buffer : null;
};

const validateAttachment = (attachment) => {
  if (attachment === undefined || attachment === null) {
    return null;
  }

  if (typeof attachment !== 'object') {
    return 'Attachment is invalid.';
  }

  const { name, type, data } = attachment;

  if (!type || !ALLOWED_ATTACHMENT_TYPES.has(type)) {
    return 'This file type is not allowed.';
  }

  if (typeof name !== 'string' || !name.trim()) {
    return 'Attachment name is required.';
  }

  if (typeof data !== 'string' || !data) {
    return 'Attachment data is missing.';
  }

  if (data.length > Math.ceil((MAX_ATTACHMENT_BYTES / 3) * 4) + 16) {
    return 'Attachment is too large (max 4 MB).';
  }

  return null;
};

const validateMessagePayload = (senderId, receiverId, message, attachment) => {
  if (!receiverId || !mongoose.isValidObjectId(receiverId)) {
    return 'Valid receiverId is required.';
  }

  const attachmentError = validateAttachment(attachment);

  if (attachmentError) {
    return attachmentError;
  }

  const hasText = typeof message === 'string' && Boolean(message.trim());

  if (!hasText && !attachment) {
    return 'Message cannot be empty.';
  }

  if (senderId === receiverId) {
    return 'You cannot send a message to yourself.';
  }

  return null;
};

const storeEncryptedMessage = async ({ senderId, receiverId, message, attachment, replyTo }) => {
  const payloadError = validateMessagePayload(senderId, receiverId, message, attachment);

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

  const fields = { sender: senderId, receiver: receiverObjectId, status: 'sent' };

  if (replyTo) {
    if (!mongoose.isValidObjectId(replyTo)) {
      const error = new Error('Invalid reply target.');
      error.status = 400;
      throw error;
    }

    const target = await Message.findById(replyTo);
    const sameConversation =
      target &&
      [String(target.sender), String(target.receiver)].includes(String(senderId)) &&
      [String(target.sender), String(target.receiver)].includes(String(receiverObjectId));

    if (!sameConversation) {
      const error = new Error('You can only reply to messages in this conversation.');
      error.status = 400;
      throw error;
    }

    const previewText = target.encryptedMessage
      ? decryptText({
          encryptedMessage: target.encryptedMessage,
          iv: target.iv,
          authTag: target.authTag,
        })
      : target.attachment
        ? target.attachment.name
        : '';
    const encryptedPreview = encryptText(previewText.slice(0, 200));

    fields.replyTo = {
      message: target._id,
      sender: target.sender,
      encryptedPreview: encryptedPreview.encryptedMessage,
      iv: encryptedPreview.iv,
      authTag: encryptedPreview.authTag,
    };
  }

  if (typeof message === 'string' && message.trim()) {
    const encrypted = encryptText(message.trim());
    fields.encryptedMessage = encrypted.encryptedMessage;
    fields.iv = encrypted.iv;
    fields.authTag = encrypted.authTag;
  }

  if (attachment) {
    const bytes = decodeBase64(attachment.data);

    if (!bytes) {
      const error = new Error('Attachment data is not valid base64.');
      error.status = 400;
      throw error;
    }

    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      const error = new Error('Attachment is too large (max 4 MB).');
      error.status = 400;
      throw error;
    }

    const encryptedFile = encryptBuffer(bytes);

    fields.attachment = {
      data: encryptedFile.data,
      iv: encryptedFile.iv,
      authTag: encryptedFile.authTag,
      contentType: attachment.type,
      size: bytes.length,
      name: sanitizeFileName(attachment.name),
    };
  }

  const stored = await Message.create(fields);

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

const formatMessage = (messageDoc, currentUserId) => {
  const hasAttachment = Boolean(messageDoc.attachment && messageDoc.attachment.data);

  return {
    id: messageDoc._id,
    sender: messageDoc.sender,
    receiver: messageDoc.receiver,
    message: messageDoc.encryptedMessage
      ? decryptText({
          encryptedMessage: messageDoc.encryptedMessage,
          iv: messageDoc.iv,
          authTag: messageDoc.authTag,
        })
      : '',
    attachment: hasAttachment
      ? {
          name: messageDoc.attachment.name,
          contentType: messageDoc.attachment.contentType,
          size: messageDoc.attachment.size,
          url: `/api/messages/${messageDoc._id}/attachment`,
        }
      : null,
    replyTo:
      messageDoc.replyTo && messageDoc.replyTo.encryptedPreview
        ? {
            id: messageDoc.replyTo.message,
            sender: messageDoc.replyTo.sender,
            text: decryptText({
              encryptedMessage: messageDoc.replyTo.encryptedPreview,
              iv: messageDoc.replyTo.iv,
              authTag: messageDoc.replyTo.authTag,
            }),
          }
        : null,
    editedAt: messageDoc.editedAt || null,
    timestamp: messageDoc.createdAt,
    status: messageDoc.status || 'sent',
    isOwnMessage: String(messageDoc.sender) === String(currentUserId),
  };
};

// Only the two participants may read an attachment; bytes stay encrypted at rest.
const getAttachment = async (req, res) => {
  try {
    const { messageId } = req.params;

    if (!mongoose.isValidObjectId(messageId)) {
      return res.status(400).json({ message: 'Invalid message ID.' });
    }

    const doc = await Message.findById(messageId);

    if (!doc || !doc.attachment || !doc.attachment.data) {
      return res.status(404).json({ message: 'Attachment not found.' });
    }

    const viewer = String(req.user.id);

    if (viewer !== String(doc.sender) && viewer !== String(doc.receiver)) {
      return res.status(403).json({ message: 'You are not part of this conversation.' });
    }

    const buffer = decryptBuffer({
      data: doc.attachment.data,
      iv: doc.attachment.iv,
      authTag: doc.attachment.authTag,
    });

    res.set('Content-Type', doc.attachment.contentType || 'application/octet-stream');
    res.set(
      'Content-Disposition',
      `inline; filename="${(doc.attachment.name || 'attachment').replace(/"/g, '')}"`,
    );
    res.set('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(buffer);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to serve attachment:', error);
    return res.status(500).json({ message: 'Unable to read attachment.' });
  }
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const parsePageOptions = (query) => {
  const rawLimit = Number.parseInt(query.limit, 10);
  const limit = Number.isNaN(rawLimit) ? DEFAULT_PAGE_SIZE : rawLimit;

  return {
    limit: Math.min(Math.max(limit, 1), MAX_PAGE_SIZE),
    before: query.before,
  };
};

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

    const { limit, before } = parsePageOptions(req.query);
    const filter = {
      $or: [
        { sender: currentUserId, receiver: otherUserId },
        { sender: otherUserId, receiver: currentUserId },
      ],
    };

    if (before) {
      if (!mongoose.isValidObjectId(before)) {
        return res.status(400).json({ message: 'Invalid pagination cursor.' });
      }

      // Newest-first scan: everything older than the cursor.
      filter._id = { $lt: new mongoose.Types.ObjectId(before) };
    }

    const docs = await Message.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = docs.length > limit;
    const page = (hasMore ? docs.slice(0, limit) : docs).reverse();
    const decrypted = page.map((message) => formatMessage(message, req.user.id));

    return res.status(200).json({
      messages: decrypted,
      nextCursor: hasMore && decrypted.length ? String(decrypted[0].id) : null,
      hasMore,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to fetch conversation:', error);
    return res.status(500).json({ message: 'Unable to fetch messages.' });
  }
};

const sendMessage = async (req, res) => {
  try {
    const { receiverId, message, attachment, replyTo } = req.body;

    const stored = await storeEncryptedMessage({
      senderId: req.user.id,
      receiverId,
      message,
      attachment,
      replyTo,
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

// Full-conversation search: the server decrypts on demand (it already holds
// the key), so matches are found even in pages the client never loaded.
const SEARCH_SCAN_LIMIT = 1000;
const SEARCH_RESULT_LIMIT = 50;
const MIN_SEARCH_LENGTH = 2;

const searchMessages = async (req, res) => {
  try {
    const { userId } = req.params;
    const query = String(req.query.q || '').trim();

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid user ID.' });
    }

    if (query.length < MIN_SEARCH_LENGTH) {
      return res.status(400).json({ message: 'Search needs at least 2 characters.' });
    }

    const otherUserId = new mongoose.Types.ObjectId(userId);
    const currentUserId = new mongoose.Types.ObjectId(req.user.id);
    const otherUser = await User.findById(otherUserId).select('_id');

    if (!otherUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const docs = await Message.find({
      $or: [
        { sender: currentUserId, receiver: otherUserId },
        { sender: otherUserId, receiver: currentUserId },
      ],
    })
      .sort({ _id: -1 })
      .limit(SEARCH_SCAN_LIMIT)
      .lean();

    const needle = query.toLowerCase();
    const matches = [];

    for (const doc of docs) {
      if (!doc.encryptedMessage) {
        continue; // attachment-only message
      }

      let text;

      try {
        text = decryptText({
          encryptedMessage: doc.encryptedMessage,
          iv: doc.iv,
          authTag: doc.authTag,
        });
      } catch (error) {
        continue; // undecryptable doc should not fail the whole search
      }

      if (text.toLowerCase().includes(needle)) {
        matches.push(formatMessage(doc, req.user.id));

        if (matches.length >= SEARCH_RESULT_LIMIT) {
          break;
        }
      }
    }

    matches.reverse(); // the chat reads chronologically

    return res.status(200).json({
      query,
      results: matches,
      scanned: docs.length,
      truncated: docs.length === SEARCH_SCAN_LIMIT || matches.length >= SEARCH_RESULT_LIMIT,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to search messages:', error);
    return res.status(500).json({ message: 'Unable to search messages.' });
  }
};

module.exports = {
  getConversation,
  searchMessages,
  sendMessage,
  storeEncryptedMessage,
  formatMessage,
  markMessagesDelivered,
  markMessagesSeen,
  getAttachment,
};
