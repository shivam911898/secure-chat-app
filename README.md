# Secure Chat App

Beginner-friendly secure real-time one-to-one chat application built with CommonJS Node.js, Express, MongoDB, JWT auth, bcrypt password hashing, Socket.IO, and vanilla HTML/CSS/JavaScript.

## Features

- User registration and login with JWT authentication
- Password hashing using `bcryptjs`
- Protected REST APIs
- User list excluding logged-in user
- One-to-one real-time messaging via Socket.IO
- Persistent conversation history in MongoDB
- Message encryption at rest using AES-256-GCM (server-side)
- Unread-message badge for chats that are not open
- Delivery ticks on your own messages: Sent, Delivered, Seen
- Clean modular folder structure for learning

## Tech Stack

- Backend: Node.js, Express.js, Socket.IO, Mongoose
- API protection: express-rate-limit
- Auth & Security: JWT, bcryptjs, Node `crypto` (AES-256-GCM)
- Frontend: Vanilla HTML, CSS, JavaScript
- Config: dotenv

## Folder Structure

```text
secure-chat-app/
├── config/
│   └── db.js
├── controllers/
│   ├── authController.js
│   ├── messageController.js
│   └── userController.js
├── middleware/
│   └── authMiddleware.js
├── models/
│   ├── Message.js
│   └── User.js
├── public/
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   ├── chat.js
│   │   ├── login.js
│   │   └── register.js
│   ├── chat.html
│   ├── login.html
│   └── register.html
├── routes/
│   ├── authRoutes.js
│   ├── messageRoutes.js
│   └── userRoutes.js
├── sockets/
│   └── chatSocket.js
├── utils/
│   └── encryption.js
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── README.md
└── server.js
```

## MongoDB Setup

1. Install MongoDB locally, or use MongoDB Atlas.
2. Copy `.env.example` to `.env`.
3. Set `MONGO_URI` in `.env`.

## Environment Configuration

Create `.env` in project root:

```env
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/secure-chat-app
JWT_SECRET=replace_with_a_strong_random_jwt_secret
JWT_EXPIRES_IN=1d
ENCRYPTION_KEY=replace_with_64_hex_characters
```

### Encryption Key Format

- `ENCRYPTION_KEY` must be exactly a **64-character hex string** (32 bytes).
- Generate locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> This app encrypts messages on the server before saving to MongoDB. This is not full end-to-end encryption.

The server validates `ENCRYPTION_KEY` and `JWT_SECRET` at startup and exits with an actionable
message if either is missing or still the `.env.example` placeholder, so a bad key fails loudly
at boot instead of surfacing later as `Unable to deliver message.`

## Install and Run

```bash
npm install
```

```bash
npm start
```

Optional development mode:

```bash
npm run dev
```

Open:

- `http://localhost:5000/login.html`
- `http://localhost:5000/register.html`
- `http://localhost:5000/chat.html`

## API Endpoints

All protected endpoints require an `Authorization` header containing a JWT in the standard bearer-token format.

### Auth

- `POST /api/auth/register`
  - body: `{ "name": "User", "email": "user@email.com", "password": "secret123" }`
- `POST /api/auth/login`
  - body: `{ "email": "user@email.com", "password": "secret123" }`

### Users

- `GET /api/users`
  - returns all users except the authenticated user

### Messages

- `GET /api/messages/:userId`
  - conversation history between logged-in user and `:userId`
- `POST /api/messages`
  - body: `{ "receiverId": "<userId>", "message": "Hello" }`

## Socket.IO Flow

1. Client logs in and stores JWT.
2. Client connects socket with JWT in `auth.token`.
3. Server verifies JWT in socket middleware.
4. Client emits `privateMessage` with `{ receiverId, message }`.
5. Server validates sender, encrypts message, stores in MongoDB.
6. Server emits `messageReceived` to sender and receiver.
7. Client listens to `messageReceived` and updates chat UI.

## Message Status (Sent / Delivered / Seen)

Every message stores a `status` that only ever moves forward:

| Status | Meaning |
| --- | --- |
| `sent` | Stored in MongoDB. The receiver was offline. |
| `delivered` | The receiver's socket is connected, so the message reached their device. |
| `seen` | The receiver opened that conversation. |

How the transitions happen:

- `sent` is set when the message is created.
- On `connection`, the server flushes everything queued for that user to `delivered`
  and emits `messageStatus` to each sender.
- When the client opens a conversation it emits `conversationOpened` with
  `{ userId }`; the server marks those messages `seen` and emits `messageStatus`
  to the other side.
- The sender's own bubbles render `✓ Sent`, `✓✓ Delivered`, `✓✓ Seen` and update live.

Incoming messages for a conversation that is not open increment an unread badge in
the sidebar; opening or receiving in the open chat clears it.

## JWT Authentication (Simple Explanation)

- On login/register, server signs a JWT containing user ID.
- Protected routes and socket middleware verify this token.
- Invalid, missing, or expired tokens are rejected.
- Logout is client-side: remove JWT from local storage.

## Encryption (Simple Explanation)

- Message text is encrypted with AES-256-GCM before DB storage.
- MongoDB stores: `encryptedMessage`, `iv`, and `authTag`.
- Decryption happens only when authorized sender/receiver fetches messages.
- Encryption key is loaded from environment and never hard-coded.

## Postman Testing Guide

1. Register User A and User B.
2. Login as User A and copy JWT.
3. Call `GET /api/users` with bearer token.
4. Send `POST /api/messages` to User B.
5. Call `GET /api/messages/:userId` to verify history.
6. Open two browser sessions and verify real-time delivery with sockets.

## Security Considerations

- Never commit `.env` or real secrets.
- Passwords are hashed (not stored plaintext).
- JWT is required for protected routes and socket messaging.
- Message data is encrypted at rest in DB.
- API and socket errors avoid exposing sensitive internal details.
- API requests are rate-limited to reduce brute-force and abuse risk.
