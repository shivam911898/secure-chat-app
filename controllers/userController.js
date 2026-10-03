const User = require('../models/User');

const getUsers = async (req, res) => {
  try {
    const users = await User.find({ _id: { $ne: req.user.id } }).select('name email createdAt');
    return res.status(200).json(users);
  } catch (error) {
    return res.status(500).json({ message: 'Unable to fetch users.' });
  }
};

module.exports = {
  getUsers,
};
