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
    const received = {
      messages: [],
      statuses: [],
      typing: [],
      presence: [],
      calls: [],
      errors: [],
      edits: [],
      missedCalls: [],
    };

    socket.on('messageReceived', (payload) => received.messages.push(payload));
    socket.on('messageStatus', (payload) => received.statuses.push(payload));
    socket.on('typing', (payload) => received.typing.push(payload));
    socket.on('presenceUpdate', (payload) => received.presence.push(payload));
    socket.on('chatError', (payload) => received.errors.push(payload));
    socket.on('messageEdited', (payload) => received.edits.push(payload));
    socket.on('callMissed', (payload) => received.missedCalls.push(payload));

    ['call:invite', 'call:accept', 'call:reject', 'call:hangup', 'call:signal'].forEach(
      (event) => {
        socket.on(event, (payload) => received.calls.push({ event, payload }));
      },
    );

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
  test('never lists yourself', async () => {
    const me = await registerUser('viewer');

    const res = await request(BASE_URL)
      .get('/api/users')
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((user) => user.email)).not.toContain(me.user.email);
  });
});

describe('contact privacy and people search', () => {
  test('the default list only contains people you have messaged', async () => {
    const me = await registerUser('private');
    const stranger = await registerUser('stranger');
    const contact = await registerUser('contact');

    await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${me.token}`)
      .send({ receiverId: contact.user.id, message: 'hello contact' })
      .expect(201);

    const res = await request(BASE_URL)
      .get('/api/users')
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    const emails = res.body.map((user) => user.email);
    expect(emails).toContain(contact.user.email);
    expect(emails).not.toContain(stranger.user.email);
  });

  test('search needs two characters and only matches what you type', async () => {
    const me = await registerUser('searcher');
    const target = await registerUser('zebrafinder');

    const tooShort = await request(BASE_URL)
      .get('/api/users?search=Z')
      .set('Authorization', `Bearer ${me.token}`);
    expect(tooShort.status).toBe(200);
    expect(tooShort.body).toEqual([]);

    const res = await request(BASE_URL)
      .get('/api/users?search=zebra')
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    const emails = res.body.map((user) => user.email);
    expect(emails).toContain(target.user.email);
    expect(emails).not.toContain(me.user.email);
  });

  test('search results are capped', async () => {
    const me = await registerUser('capper');

    for (let i = 0; i < 12; i += 1) {
      await registerUser('commonprefix');
    }

    const res = await request(BASE_URL)
      .get('/api/users?search=commonprefix')
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.length).toBeLessThanOrEqual(10);
  });

  test('search treats regex characters as plain text', async () => {
    const me = await registerUser('regexuser');

    const res = await request(BASE_URL)
      .get('/api/users?search=.*')
      .set('Authorization', `Bearer ${me.token}`);

    // "\.\*" must be escaped, so nothing matches instead of "everything".
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
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

describe('video call signalling', () => {
  let alice;
  let bob;
  let aliceSocket;
  let bobSocket;

  beforeAll(async () => {
    alice = await registerUser('call-alice');
    bob = await registerUser('call-bob');
    aliceSocket = await connectSocket(alice.token);
    bobSocket = await connectSocket(bob.token);
  });

  afterAll(() => {
    aliceSocket.socket.close();
    bobSocket.socket.close();
  });

  test('relays an invite to the callee with the caller id', async () => {
    aliceSocket.socket.emit('call:invite', { to: bob.user.id, callId: 'call-1' });

    const invite = await waitFor(
      () => bobSocket.received.calls.find((item) => item.event === 'call:invite'),
      5000,
      'the call invite',
    );

    expect(invite.payload.from).toBe(alice.user.id);
    expect(invite.payload.callId).toBe('call-1');
  });

  test('relays SDP offers and answers in both directions', async () => {
    aliceSocket.socket.emit('call:signal', {
      to: bob.user.id,
      callId: 'call-1',
      data: { sdp: { type: 'offer', sdp: 'v=0\\r\\n' } },
    });

    const offer = await waitFor(
      () =>
        bobSocket.received.calls.find(
          (item) => item.event === 'call:signal' && item.payload.data.sdp,
        ),
      5000,
      'the offer',
    );
    expect(offer.payload.data.sdp.type).toBe('offer');
    expect(offer.payload.from).toBe(alice.user.id);

    bobSocket.socket.emit('call:signal', {
      to: alice.user.id,
      callId: 'call-1',
      data: { sdp: { type: 'answer', sdp: 'v=0' } },
    });

    const answer = await waitFor(
      () =>
        aliceSocket.received.calls.find(
          (item) =>
            item.event === 'call:signal' &&
            item.payload.data.sdp &&
            item.payload.data.sdp.type === 'answer',
        ),
      5000,
      'the answer',
    );
    expect(answer.payload.from).toBe(bob.user.id);
  });

  test('relays ICE candidates, accept and hangup', async () => {
    aliceSocket.socket.emit('call:signal', {
      to: bob.user.id,
      callId: 'call-1',
      data: { candidate: { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host' } },
    });

    const ice = await waitFor(
      () =>
        bobSocket.received.calls.find(
          (item) => item.event === 'call:signal' && item.payload.data.candidate,
        ),
      5000,
      'the ICE candidate',
    );
    expect(ice.payload.data.candidate.candidate).toContain('typ host');

    bobSocket.socket.emit('call:accept', { to: alice.user.id, callId: 'call-1' });
    const accepted = await waitFor(
      () => aliceSocket.received.calls.find((item) => item.event === 'call:accept'),
      5000,
      'the accept',
    );
    expect(accepted.payload.from).toBe(bob.user.id);

    aliceSocket.socket.emit('call:hangup', { to: bob.user.id, callId: 'call-1' });
    const ended = await waitFor(
      () => bobSocket.received.calls.find((item) => item.event === 'call:hangup'),
      5000,
      'the hangup',
    );
    expect(ended.payload.from).toBe(alice.user.id);
  });

  test('drops signals addressed to yourself or an invalid id', async () => {
    const before = bobSocket.received.calls.length;

    aliceSocket.socket.emit('call:invite', { to: alice.user.id, callId: 'self-call' });
    aliceSocket.socket.emit('call:invite', { to: 'not-an-object-id', callId: 'bad-call' });

    await sleep(400);

    expect(bobSocket.received.calls.length).toBe(before);
    const leaked = aliceSocket.received.calls.filter(
      (item) => item.payload.callId === 'self-call' || item.payload.callId === 'bad-call',
    );
    expect(leaked).toHaveLength(0);
  });
});

describe('attachments', () => {
  // 1x1 transparent PNG
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  let sender;
  let receiver;
  let stranger;
  let attachmentMessageId;

  beforeAll(async () => {
    sender = await registerUser('file-sender');
    receiver = await registerUser('file-receiver');
    stranger = await registerUser('file-stranger');
  });

  test('sends an image with no text and returns a download url', async () => {
    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        receiverId: receiver.user.id,
        attachment: { name: 'pixel.png', type: 'image/png', data: PNG_BASE64 },
      });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('');
    expect(res.body.attachment).toMatchObject({
      name: 'pixel.png',
      contentType: 'image/png',
    });
    expect(res.body.attachment.url).toEqual(expect.any(String));
    attachmentMessageId = String(res.body.id);
  });

  test('serves the original bytes, but only to the two participants', async () => {
    const asSender = await request(BASE_URL)
      .get(`/api/messages/${attachmentMessageId}/attachment`)
      .set('Authorization', `Bearer ${sender.token}`);

    expect(asSender.status).toBe(200);
    expect(asSender.headers['content-type']).toContain('image/png');
    expect(Buffer.from(asSender.body).toString('base64')).toBe(PNG_BASE64);

    const asReceiver = await request(BASE_URL)
      .get(`/api/messages/${attachmentMessageId}/attachment`)
      .set('Authorization', `Bearer ${receiver.token}`);
    expect(asReceiver.status).toBe(200);

    const asStranger = await request(BASE_URL)
      .get(`/api/messages/${attachmentMessageId}/attachment`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(asStranger.status).toBe(403);

    const anonymous = await request(BASE_URL).get(
      `/api/messages/${attachmentMessageId}/attachment`,
    );
    expect(anonymous.status).toBe(401);
  });

  test('stores text and an attachment together', async () => {
    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        receiverId: receiver.user.id,
        message: 'caption with the picture',
        attachment: { name: 'pixel.png', type: 'image/png', data: PNG_BASE64 },
      });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('caption with the picture');
    expect(res.body.attachment.name).toBe('pixel.png');
  });

  test('rejects an unsupported file type', async () => {
    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        receiverId: receiver.user.id,
        attachment: { name: 'page.html', type: 'text/html', data: PNG_BASE64 },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('This file type is not allowed.');
  });

  test('rejects malformed base64', async () => {
    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        receiverId: receiver.user.id,
        attachment: { name: 'pixel.png', type: 'image/png', data: 'not!base64' },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Attachment data is not valid base64.');
  });

  test('rejects a payload over 4 MB', async () => {
    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${sender.token}`)
      .send({
        receiverId: receiver.user.id,
        attachment: {
          name: 'huge.png',
          type: 'image/png',
          // 5.6 M base64 chars is over the 4 MB decoded cap but still fits
          // under the 6 MB JSON body limit, so the app-level check runs first.
          data: 'A'.repeat(5600000),
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Attachment is too large (max 4 MB).');
  });

  test('delivers an attachment in realtime over the socket', async () => {
    const alice = await registerUser('att-alice');
    const bob = await registerUser('att-bob');
    const aliceSocket = await connectSocket(alice.token);
    const bobSocket = await connectSocket(bob.token);

    aliceSocket.socket.emit('privateMessage', {
      receiverId: bob.user.id,
      message: 'look at this',
      attachment: { name: 'pixel.png', type: 'image/png', data: PNG_BASE64 },
    });

    const received = await waitFor(
      () => bobSocket.received.messages.find((m) => m.message === 'look at this'),
      5000,
      'the attachment message',
    );

    expect(received.attachment).toMatchObject({ name: 'pixel.png', contentType: 'image/png' });
    expect(received.attachment.url).toEqual(expect.any(String));

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });
});

describe('missed calls', () => {
  test('an unanswered call is recorded and reported to the callee', async () => {
    const caller = await registerUser('mc-caller');
    const callee = await registerUser('mc-callee');
    const callerSocket = await connectSocket(caller.token);
    const calleeSocket = await connectSocket(callee.token);

    const callId = `call-${Date.now()}`;
    callerSocket.socket.emit('call:invite', { to: callee.user.id, callId });

    await waitFor(
      () =>
        calleeSocket.received.calls.find(
          (call) => call.event === 'call:invite' && call.payload.callId === callId,
        ),
      5000,
      'the callee to receive the invite',
    );

    // Nobody answers; the caller hangs up while the call is still ringing.
    callerSocket.socket.emit('call:hangup', { to: callee.user.id, callId });

    const missedEvent = await waitFor(
      () => calleeSocket.received.missedCalls.find((m) => m.from === caller.user.id),
      5000,
      'the missed-call event',
    );
    expect(missedEvent.from).toBe(caller.user.id);

    const list = await request(BASE_URL)
      .get('/api/calls/missed')
      .set('Authorization', `Bearer ${callee.token}`);
    expect(list.status).toBe(200);

    const record = list.body.find((item) => String(item.from) === String(caller.user.id));
    expect(record).toBeDefined();
    expect(record.name).toBe(caller.user.name);

    // Opening the conversation clears it.
    await request(BASE_URL)
      .post('/api/calls/seen')
      .set('Authorization', `Bearer ${callee.token}`)
      .send({ from: caller.user.id })
      .expect(200);

    const after = await request(BASE_URL)
      .get('/api/calls/missed')
      .set('Authorization', `Bearer ${callee.token}`);
    expect(after.body.find((item) => String(item.from) === String(caller.user.id))).toBeUndefined();

    callerSocket.socket.close();
    calleeSocket.socket.close();
  });

  test('an answered call does not show up as missed', async () => {
    const caller = await registerUser('ac-caller');
    const callee = await registerUser('ac-callee');
    const callerSocket = await connectSocket(caller.token);
    const calleeSocket = await connectSocket(callee.token);

    const callId = `call-${Date.now()}`;
    callerSocket.socket.emit('call:invite', { to: callee.user.id, callId });

    await waitFor(
      () => calleeSocket.received.calls.find((call) => call.event === 'call:invite'),
      5000,
      'the invite',
    );

    calleeSocket.socket.emit('call:accept', { to: caller.user.id, callId });
    await waitFor(
      () => callerSocket.received.calls.find((call) => call.event === 'call:accept'),
      5000,
      'the accept',
    );
    calleeSocket.socket.emit('call:hangup', { to: caller.user.id, callId });
    await sleep(300);

    const list = await request(BASE_URL)
      .get('/api/calls/missed')
      .set('Authorization', `Bearer ${callee.token}`);
    expect(list.status).toBe(200);
    expect(list.body.find((item) => String(item.from) === String(caller.user.id))).toBeUndefined();

    callerSocket.socket.close();
    calleeSocket.socket.close();
  });
});

describe('replying to messages', () => {
  test('stores the reply with a preview both sides can read', async () => {
    const alice = await registerUser('reply-alice');
    const bob = await registerUser('reply-bob');

    const original = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ receiverId: bob.user.id, message: 'the original question' })
      .expect(201);

    const reply = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ receiverId: alice.user.id, message: 'my answer', replyTo: original.body.id })
      .expect(201);

    expect(reply.body.replyTo).toMatchObject({
      id: original.body.id,
      text: 'the original question',
    });

    const history = await request(BASE_URL)
      .get(`/api/messages/${bob.user.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);

    const stored = history.body.messages.find((item) => item.id === reply.body.id);
    expect(stored.replyTo).toMatchObject({ text: 'the original question' });
  });

  test('cannot reply to a message from another conversation', async () => {
    const alice = await registerUser('cross-a');
    const bob = await registerUser('cross-b');
    const carol = await registerUser('cross-c');

    const foreign = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ receiverId: carol.user.id, message: 'not for alice' })
      .expect(201);

    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ receiverId: bob.user.id, message: 'hi', replyTo: foreign.body.id });

    expect(res.status).toBe(400);
  });

  test('rejects a reply to a message that does not exist', async () => {
    const alice = await registerUser('ghost-a');
    const bob = await registerUser('ghost-b');

    const res = await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({
        receiverId: bob.user.id,
        message: 'hi',
        replyTo: '0'.repeat(24),
      });

    expect(res.status).toBe(400);
  });
});

describe('editing messages', () => {
  test('the author can edit and both sides see the update', async () => {
    const alice = await registerUser('edit-alice');
    const bob = await registerUser('edit-bob');
    const aliceSocket = await connectSocket(alice.token);
    const bobSocket = await connectSocket(bob.token);

    aliceSocket.socket.emit('privateMessage', {
      receiverId: bob.user.id,
      message: 'teh orignal',
    });

    const sent = await waitFor(
      () => bobSocket.received.messages.find((m) => m.message === 'teh orignal'),
      5000,
      'the original message',
    );

    aliceSocket.socket.emit('editMessage', {
      messageId: String(sent.id),
      text: 'the original',
    });

    const forAuthor = await waitFor(
      () => aliceSocket.received.edits.find((m) => String(m.id) === String(sent.id)),
      5000,
      'the edit event for the author',
    );
    const forPeer = await waitFor(
      () => bobSocket.received.edits.find((m) => String(m.id) === String(sent.id)),
      5000,
      'the edit event for the peer',
    );

    expect(forAuthor.message).toBe('the original');
    expect(forAuthor.editedAt).toEqual(expect.any(String));
    expect(forPeer.message).toBe('the original');

    const history = await request(BASE_URL)
      .get(`/api/messages/${bob.user.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const stored = history.body.messages.find((item) => item.id === sent.id);
    expect(stored.message).toBe('the original');
    expect(stored.editedAt).toEqual(expect.any(String));

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });

  test('only the author can edit', async () => {
    const alice = await registerUser('own-a');
    const bob = await registerUser('own-b');
    const aliceSocket = await connectSocket(alice.token);
    const bobSocket = await connectSocket(bob.token);

    aliceSocket.socket.emit('privateMessage', {
      receiverId: bob.user.id,
      message: 'alice wrote this',
    });

    const sent = await waitFor(
      () => bobSocket.received.messages.find((m) => m.message === 'alice wrote this'),
      5000,
      'the message',
    );

    bobSocket.socket.emit('editMessage', {
      messageId: String(sent.id),
      text: 'bob was here',
    });

    const error = await waitFor(
      () => bobSocket.received.errors.find((e) => /own messages/.test(e.message)),
      5000,
      'the ownership error',
    );
    expect(error.message).toMatch(/own messages/);
    expect(aliceSocket.received.edits).toHaveLength(0);

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });

  test('rejects an empty edit', async () => {
    const alice = await registerUser('empty-a');
    const bob = await registerUser('empty-b');
    const aliceSocket = await connectSocket(alice.token);
    const bobSocket = await connectSocket(bob.token);

    aliceSocket.socket.emit('privateMessage', {
      receiverId: bob.user.id,
      message: 'something',
    });

    const sent = await waitFor(
      () => bobSocket.received.messages.find((m) => m.message === 'something'),
      5000,
      'the message',
    );

    aliceSocket.socket.emit('editMessage', { messageId: String(sent.id), text: '   ' });

    const error = await waitFor(
      () => aliceSocket.received.errors.find((e) => /empty/.test(e.message)),
      5000,
      'the empty-text error',
    );
    expect(error.message).toMatch(/empty/);

    aliceSocket.socket.close();
    bobSocket.socket.close();
  });
});

describe('conversation search', () => {
  test(
    'finds a message the client never loaded',
    async () => {
      const alice = await registerUser('deep-a');
      const bob = await registerUser('deep-b');

      // Sent first, so it is the oldest message and falls outside the newest 50.
      const marker = await request(BASE_URL)
        .post('/api/messages')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ receiverId: bob.user.id, message: 'the zebra manifest is ready' })
        .expect(201);

      for (let i = 1; i <= 55; i += 1) {
        await request(BASE_URL)
          .post('/api/messages')
          .set('Authorization', `Bearer ${alice.token}`)
          .send({ receiverId: bob.user.id, message: `filler message ${i}` })
          .expect(201);
      }

      const page = await request(BASE_URL)
        .get(`/api/messages/${bob.user.id}`)
        .set('Authorization', `Bearer ${alice.token}`)
        .expect(200);
      expect(page.body.messages.some((m) => m.message.includes('zebra'))).toBe(false);

      const res = await request(BASE_URL)
        .get(`/api/messages/${bob.user.id}/search?q=${encodeURIComponent('zebra manifest')}`)
        .set('Authorization', `Bearer ${alice.token}`);

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].message).toBe('the zebra manifest is ready');
      expect(res.body.results[0].id).toBe(marker.body.id);
    },
    30000,
  );

  test('is case-insensitive, scoped to the conversation and needs 2 characters', async () => {
    const alice = await registerUser('scope-a');
    const bob = await registerUser('scope-b');
    const carol = await registerUser('scope-c');

    await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ receiverId: bob.user.id, message: 'Meeting Notes for monday' })
      .expect(201);
    await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ receiverId: carol.user.id, message: 'meeting notes for carol' })
      .expect(201);

    const tooShort = await request(BASE_URL)
      .get(`/api/messages/${bob.user.id}/search?q=m`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(tooShort.status).toBe(400);

    const res = await request(BASE_URL)
      .get(`/api/messages/${bob.user.id}/search?q=${encodeURIComponent('MEETING')}`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].message).toBe('Meeting Notes for monday');
  });

  test('does not leak other conversations', async () => {
    const alice = await registerUser('leak-a');
    const bob = await registerUser('leak-b');
    const mallory = await registerUser('leak-mallory');

    await request(BASE_URL)
      .post('/api/messages')
      .set('Authorization', `Bearer ${mallory.token}`)
      .send({ receiverId: bob.user.id, message: 'top secret plans' })
      .expect(201);

    const res = await request(BASE_URL)
      .get(`/api/messages/${bob.user.id}/search?q=${encodeURIComponent('secret')}`)
      .set('Authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});
