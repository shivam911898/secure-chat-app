const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI is missing in environment variables');
    }

    await mongoose.connect(process.env.MONGO_URI);
    // eslint-disable-next-line no-console
    console.log('MongoDB connected');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Database connection failed:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
