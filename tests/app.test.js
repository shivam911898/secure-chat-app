const path = require('path');
const { spawn } = require('child_process');
const request = require('supertest');
const { io } = require('socket.io-client');

const PORT = process.env.TEST_PORT || 5399;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_MONGO_URI =
  process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/secure-chat-app-test';
const TEST_ENCRYPTION_KEY = 'b'.repeat(64);

let child = null;
let serverOutput = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Traces go to stderr so lint stays clean (no-console) while debugging setup failures.
const trace = (message) => process.stderr.write(`[setup] ${message}\n`);

const waitFor = async (probe, timeout = 5000, label = 'condition') => {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const value = await probe();

    if (value) {
      return value;
    }

    await sleep(50);
  }

  throw new Error(`Timed out waiting for ${label}`);
};

const registerUser = async (name) => {
  const email = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  const res = await request(BASE_URL)
    .post('/api/auth/register')
    .send({ name, email, password: 'secret123' });

  expect(res.status).toBe(201);
  return res.body;
};

const connectSocket = (token) =>
  new Promise((resolve, reject) => {
    const socket = io(BASE_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    const received = { messages: [], statuses: [], typing: [], presence: [] };

    socket.on('messageReceived', (payload) => received.messages.push(payload));
    socket.on('messageStatus', (payload) => received.statuses.push(payload));
    socket.on('typing', (payload) => received.typing.push(payload));
    socket.on('presenceUpdate', (payload) => received.presence.push(payload));

    const connectTimeout = setTimeout(() => reject(new Error('socket connect timeout')), 5000);

    socket.on('connect', () => {
      clearTimeout(connectTimeout);
      resolve({ socket, received });
    });
    socket.on('connect_error', (error) => {
      clearTimeout(connectTimeout);
      reject(error);
    });
  });

beforeAll(async () => {
  // The test process must not open its own Mongo connection: Jest's VM context
  // breaks the driver's handshake. The spawned server owns the database, and
  // every test below creates its own users, so no cleanup is required.
  trace('spawning server');

  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGO_URI: TEST_MONGO_URI,
      JWT_SECRET: 'unit-test-jwt-secret',
      JWT_EXPIRES_IN: '5m',
      ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });

  trace('waiting for the server to answer');

  try {
    await waitFor(
      async () => {
        try {
          const res = await request(BASE_URL).get('/login.html');
          return res.status === 200;
        } catch (error) {
          return false; // server not up yet
        }
      },
      20000,
      'the test server to start',
    );
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${serverOutput}`, { cause: error });
  }

  trace('server is ready');
}, 30000);

afterAll(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);

  await exited;
  clearTimeout(forceKill);
}, 30000);

describe('authentication', () => {
  test('register creates an account and returns a token', async () => {
    const body = await registerUser('alice');
    expect(body.token).toEqual(expect.any(String));
    expect(body.user.email).toMatch(/@test\.com$/);
  });

  test('register rejects a duplicate email', async () => {
    const first = await registerUser('dupe');
    const res = await request(BASE_URL)
      .post('/api/auth/register')
      .send({ name: 'dupe again', email: first.user.email, password: 'secret123' });

    expect(res.status).toBe(400);
  });

  test('login accepts good credentials and rejects bad ones', async () => {
    const account = await registerUser('carol');

    const ok = await request(BASE_URL)
      .post('/api/auth/login')
      .send({ email: account.user.email, password: 'secret123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toEqual(expect.any(String));

    const bad = await request(BASE_URL)
      .post('/api/auth/login')
      .send({ email: account.user.email, password: 'wrong-password' });
    expect(bad.status).toBe(401);
  });

  test('protected routes reject missing and malformed tokens', async () => {
    const missing = await request(BASE_URL).get('/api/users');
    expect(missing.status).toBe(401);

    const malformed = await request(BASE_URL)
      .get('/api/users')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(malformed.status).toBe(401);
  });
});

describe('users', () => {
  test('lists other users but never yourself', async () => {
    const me = await registerUser('viewer');
    const other = await registerUser('someone');

    const res = await request(BASE_URL)
      .get('/api/users')
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    const emails = res.body.map((user) => user.email);
    expect(emails).toContain(other.user.email);
    expect(emails).not.toContain(me.user.email);
  });
});

describe('messages API', () => {
  let sender;
  let receiver;

  beforeAll(async () => {
    sender = await registerUser('sender');
    receiver = await registerUser('receiver');
  });

  test('sends a message and stores it as sent', async () => {
    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ receiverId: receiver.user.id, message: 'hello there' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('hello there');
    expect(res.body.status).toBe('sent');
    expect(res.body.isOwnMessage).toBe(true);
  });

  test('rejects an empty message', async () => {
    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ receiverId: receiver.user.id, message: '   ' });

    expect(res.status).toBe(400);
  });

  test('rejects an unknown receiver', async () => {
    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ receiverId: '507f1f77bcf86cd799439011', message: 'hi' });

    expect(res.status).toBe(404);
  });

  test('rejects messages to yourself', async () => {
    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({ receiverId: sender.user.id, message: 'note to self' });

    expect(res.status).toBe(400);
  });

  test('returns conversation pages behind a cursor', async () => {
    for (let i = 1; i <= 25; i += 1) {
      const res = await request(BASE_URL)
        .post('/api/messages')
        .set('Authorization', `Bearer ${sender.token}`)
        .send({ receiverId: receiver.user.id, message: `page test ${i}` });
      expect(res.status).toBe(201);
    }

    const first = await request(BASE_URL)
      .get(`/api/messages/${receiver.user.id}?limit=10`)
      .set('Authorization', `Bearer ${sender.token}`);

    expect(first.status).toBe(200);
    expect(first.body.messages).toHaveLength(10);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(BASE_URL)
      .get(`/api/messages/${receiver.user.id}?limit=10&before=${first.body.nextCursor}`)
      .set('Authorization', `Bearer ${sender.token}`);

    expect(second.status).toBe(200);
    expect(second.body.messages).toHaveLength(10);

    const firstIds = new Set(first.body.messages.map((message) => String(message.id)));
    const overlaps = second.body.messages.filter((message) => firstIds.has(String(message.id)));
    expect(overlaps).toHaveLength(0);

    const oldest = second.body.messages[0];
    const newestOfSecond = second.body.messages[second.body.messages.length - 1];
    expect(new Date(oldest.timestamp).getTime()).toBeLessThanOrEqual(
      new Date(newestOfSecond.timestamp).getTime(),
    );
  });

  test('clamps the page size and rejects a bad cursor', async () => {
    const clamped = await request(BASE_URL)
      .get(`/api/messages/${receiver.user.id}?limit=100000`)
      .set('Authorization', `Bearer ${sender.token}`);
    expect(clamped.status).toBe(200);
    expect(clamped.body.messages.length).toBeLessThanOrEqual(100);

    const badCursor = await request(BASE_URL)
      .get(`/api/messages/${receiver.user.id}?before=not-a-cursor`)
      .set('Authorization', `Bearer ${sender.token}`);
    expect(badCursor.status).toBe(400);
  });

  test('requires a token to read history', async () => {
    const res = await request(BASE_URL).get(`/api/messages/${receiver.user.id}`);
    expect(res.status).toBe(401);
  });
});

describe('realtime', () => {
  test('rejects a socket connection with an invalid token', async () => {
    await expect(connectSocket('invalid-token')).rejects.toThrow();
  });

  test('delivers a message to both sides with delivery status', async () => {
    const alice = await registerUser('rt-alice');
    const bob = await registerUser('rt-bob');
    const aliceSocket = await connectSocket(alice.token);
    const bobSocket = await connectSocket(bob.token);

    aliceSocket.socket.emit('privateMessage', {
      receiverId: bob.user.id,
      message: 'realtime hello',
    });

    const received = await waitFor(
      () => bobSocket.received.messages.find((message) => message.message === 'realtime hello'),
      5000,
      'the receiver to get the message',
    );
    expect(received.isOwnMessage).toBe(false);

    const echo = await waitFor(
      () => aliceSocket.received.messages.find((message) => message.message === 'realtime hello'),
      5000,
      'the sender to get the echo',
    );
    expect(echo.isOwnMessage).toBe(true);
    expect(echo.status).toBe('delivered');

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });

  test('marks messages seen when the receiver opens the conversation', async () => {
    const carol = await registerUser('rt-carol');
    const dave = await registerUser('rt-dave');
    const carolSocket = await connectSocket(carol.token);
    const daveSocket = await connectSocket(dave.token);

    carolSocket.socket.emit('privateMessage', { receiverId: dave.user.id, message: 'read me' });
    const sent = await waitFor(
      () => carolSocket.received.messages.find((message) => message.message === 'read me'),
      5000,
      'the sender echo',
    );

    daveSocket.socket.emit('conversationOpened', { userId: carol.user.id });

    const seen = await waitFor(
      () =>
        carolSocket.received.statuses.find(
          (update) =>
            update.status === 'seen' && update.messageIds.map(String).includes(String(sent.id)),
        ),
      5000,
      'the seen status to reach the sender',
    );
    expect(seen.status).toBe('seen');

    carolSocket.socket.close();
    daveSocket.socket.close();
  });

  test('relays typing notifications to the other user only', async () => {
    const erin = await registerUser('rt-erin');
    const frank = await registerUser('rt-frank');
    const erinSocket = await connectSocket(erin.token);
    const frankSocket = await connectSocket(frank.token);

    erinSocket.socket.emit('typing', { receiverId: frank.user.id, isTyping: true });

    const typing = await waitFor(
      () => frankSocket.received.typing.find((update) => update.isTyping === true),
      5000,
      'the typing notification',
    );
    expect(String(typing.userId)).toBe(String(erin.user.id));

    // The sender must not receive their own typing notification.
    await sleep(200);
    expect(erinSocket.received.typing).toHaveLength(0);

    erinSocket.socket.close();
    frankSocket.socket.close();
  });

  test('broadcasts presence when a user connects and disconnects', async () => {
    const grace = await registerUser('rt-grace');
    const viewer = await registerUser('rt-viewer');
    const viewerSocket = await connectSocket(viewer.token);

    const graceSocket = await connectSocket(grace.token);

    const online = await waitFor(
      () =>
        viewerSocket.received.presence.find(
          (update) => update.userId === grace.user.id && update.online === true,
        ),
      5000,
      'the online presence update',
    );
    expect(online.userId).toBe(grace.user.id);

    graceSocket.socket.close();

    const offline = await waitFor(
      () =>
        viewerSocket.received.presence.find(
          (update) => update.userId === grace.user.id && update.online === false,
        ),
      5000,
      'the offline presence update',
    );
    expect(offline.userId).toBe(grace.user.id);

    viewerSocket.socket.close();
  });
});
