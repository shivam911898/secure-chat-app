const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    encryptedMessage: {
      type: String,
      default: '',
    },
    iv: {
      type: String,
      // Attachment-only messages carry their own IV inside `attachment`.
      required: function () {
        return !this.attachment;
      },
    },
    authTag: {
      type: String,
      required: function () {
        return !this.attachment;
      },
    },
    attachment: {
      data: { type: Buffer },
      iv: { type: String },
      authTag: { type: String },
      contentType: { type: String },
      size: { type: Number },
      name: { type: String },
    },
    replyTo: {
      message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
      sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      // The quoted text is encrypted exactly like the message body.
      encryptedPreview: { type: String },
      iv: { type: String },
      authTag: { type: String },
    },
    editedAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'seen'],
      default: 'sent',
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model('Message', messageSchema);
