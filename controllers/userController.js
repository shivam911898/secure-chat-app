const mongoose = require('mongoose');
const User = require('../models/User');
const Message = require('../models/Message');

const MAX_SEARCH_RESULTS = 10;
const MIN_SEARCH_LENGTH = 2;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Privacy first: never expose the whole user base.
//   GET /api/users            -> only people you already share a conversation with
//   GET /api/users?search=ali  -> matching accounts (2+ chars), capped, so a new
//                                 chat can still be started on purpose.
const getUsers = async (req, res) => {
  try {
    const me = new mongoose.Types.ObjectId(req.user.id);
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';

    if (search) {
      if (search.length < MIN_SEARCH_LENGTH) {
        return res.status(200).json([]);
      }

      const pattern = new RegExp(escapeRegex(search), 'i');
      const users = await User.find({
        _id: { $ne: me },
        $or: [{ name: pattern }, { email: pattern }],
      })
        .select('name email createdAt')
        .limit(MAX_SEARCH_RESULTS);

      return res.status(200).json(users);
    }

    const partners = await Message.aggregate([
      { $match: { $or: [{ sender: me }, { receiver: me }] } },
      { $sort: { _id: -1 } },
      {
        $project: {
          partner: { $cond: [{ $eq: ['$sender', me] }, '$receiver', '$sender'] },
        },
      },
      { $group: { _id: '$partner' } },
    ]);

    const ids = partners.map((partner) => partner._id);

    if (!ids.length) {
      return res.status(200).json([]);
    }

    const users = await User.find({ _id: { $in: ids } }).select('name email createdAt');

    // Keep the order the conversations were last active in.
    const rank = new Map(ids.map((id, index) => [String(id), index]));
    users.sort((a, b) => rank.get(String(a._id)) - rank.get(String(b._id)));

    return res.status(200).json(users);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to fetch users:', error);
    return res.status(500).json({ message: 'Unable to fetch users.' });
  }
};

module.exports = {
  getUsers,
};
