const path = require('path');
const http = require('http');
const express = require('express');
const dotenv = require('dotenv');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const messageRoutes = require('./routes/messageRoutes');
const registerChatSocket = require('./sockets/chatSocket');
const { apiRateLimit } = require('./middleware/rateLimitMiddleware');
const { validateEncryptionKey } = require('./utils/encryption');

dotenv.config();

// Fail fast on unusable secrets: otherwise every message send would throw
// mid-request and surface as a generic "Unable to deliver message." error.
const assertSecureConfig = () => {
  const keyError = validateEncryptionKey();

  if (keyError) {
    // eslint-disable-next-line no-console
    console.error(`Configuration error: ${keyError}`);
    // eslint-disable-next-line no-console
    console.error(
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
    process.exit(1);
  }

  if (
    !process.env.JWT_SECRET ||
    process.env.JWT_SECRET === 'replace_with_a_strong_random_jwt_secret'
  ) {
    // eslint-disable-next-line no-console
    console.error(
      'Configuration error: JWT_SECRET is missing or still the .env.example placeholder.',
    );
    // eslint-disable-next-line no-console
    console.error(
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
    process.exit(1);
  }
};

assertSecureConfig();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

connectDB();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(apiRateLimit);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/messages', messageRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({ message: 'Internal server error' });
});

registerChatSocket(io);

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on port ${PORT}`);
});
