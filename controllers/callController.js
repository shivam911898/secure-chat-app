const mongoose = require('mongoose');
const Call = require('../models/Call');

const MAX_MISSED_CALLS = 20;

const getMissedCalls = async (req, res) => {
  try {
    const me = new mongoose.Types.ObjectId(req.user.id);

    const calls = await Call.find({ callee: me, status: 'missed', read: false })
      .sort({ startedAt: -1 })
      .limit(MAX_MISSED_CALLS)
      .populate('caller', 'name email');

    const missed = calls
      .filter((call) => call.caller)
      .map((call) => ({
        id: call._id,
        from: call.caller._id,
        name: call.caller.name,
        email: call.caller.email,
        at: call.startedAt,
      }));

    return res.status(200).json(missed);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to fetch missed calls:', error);
    return res.status(500).json({ message: 'Unable to fetch missed calls.' });
  }
};

const markSeen = async (req, res) => {
  try {
    const { from } = req.body;

    if (!from || !mongoose.isValidObjectId(from)) {
      return res.status(400).json({ message: 'Valid from user id is required.' });
    }

    const me = new mongoose.Types.ObjectId(req.user.id);
    const caller = new mongoose.Types.ObjectId(from);

    await Call.updateMany(
      { callee: me, caller, status: 'missed', read: false },
      { $set: { read: true } },
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to mark missed calls as seen:', error);
    return res.status(500).json({ message: 'Unable to update missed calls.' });
  }
};

module.exports = {
  getMissedCalls,
  markSeen,
};
