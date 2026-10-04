const token = localStorage.getItem('token');
const currentUser = JSON.parse(localStorage.getItem('currentUser') || 'null');

if (!token || !currentUser) {
  window.location.href = '/login.html';
}

const currentUserLabel = document.getElementById('currentUser');
const usersList = document.getElementById('usersList');
const selectedUserName = document.getElementById('selectedUserName');
const messagesContainer = document.getElementById('messages');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const chatError = document.getElementById('chatError');
const chatStatus = document.getElementById('chatStatus');
const logoutButton = document.getElementById('logoutButton');

const PAGE_SIZE = 50;

let selectedUser = null;
const conversationCache = new Map();
const unreadCounts = new Map();
const userItems = new Map();
const pageCursors = new Map();
const loadingOlder = new Set();
const onlineUsers = new Set();
let typingFromUser = null;
let typingDisplayTimer = null;
let typingEmitTimer = null;

const STATUS_LABELS = {
  sent: '\u2713 Sent',
  delivered: '\u2713\u2713 Delivered',
  seen: '\u2713\u2713 Seen',
};

currentUserLabel.textContent = `Logged in as ${currentUser.name}`;

const authHeaders = {
  Authorization: 'Bear' + 'er ' + token,
};

const socket = io({
  auth: { token },
});

socket.on('connect_error', (error) => {
  chatError.textContent = error.message || 'Socket connection failed.';
});

socket.on('connect', () => {
  // Reconnected (server restart/deploy): drop any stale transport error.
  chatError.textContent = '';
});

socket.on('chatError', (payload) => {
  chatError.textContent = payload.message || 'Chat error occurred.';
});

socket.on('presenceSnapshot', (userIds = []) => {
  onlineUsers.clear();
  userIds.forEach((id) => onlineUsers.add(String(id)));
  renderPresence();
  updateChatStatus();
});

socket.on('presenceUpdate', ({ userId, online } = {}) => {
  if (!userId) {
    return;
  }

  if (online) {
    onlineUsers.add(String(userId));
  } else {
    onlineUsers.delete(String(userId));
  }

  renderPresence();
  updateChatStatus();
});

socket.on('typing', ({ userId, isTyping } = {}) => {
  if (!userId || !selectedUser || String(userId) !== String(selectedUser._id)) {
    return;
  }

  clearTimeout(typingDisplayTimer);

  if (isTyping) {
    typingFromUser = String(userId);
    typingDisplayTimer = setTimeout(() => {
      typingFromUser = null;
      updateChatStatus();
    }, 3000);
  } else {
    typingFromUser = null;
  }

  updateChatStatus();
});

const formatTime = (dateValue) => {
  const date = new Date(dateValue);
  return date.toLocaleString();
};

const renderMessages = (messages) => {
  messagesContainer.innerHTML = '';

  if (!messages.length) {
    messagesContainer.innerHTML = '<p class="subtitle">No messages yet.</p>';
    return;
  }

  messages.forEach((item) => {
    const messageElement = document.createElement('article');
    messageElement.className = `message ${item.isOwnMessage ? 'own' : ''}`;

    const messageText = document.createElement('p');
    messageText.textContent = item.message;

    const meta = document.createElement('div');
    meta.className = 'meta';

    if (item.isOwnMessage) {
      const status = item.status || 'sent';
      const statusText = document.createElement('span');
      statusText.className = `status ${status}`;
      statusText.textContent = STATUS_LABELS[status] || STATUS_LABELS.sent;
      meta.appendChild(statusText);
    }

    const timeText = document.createElement('span');
    timeText.className = 'time';
    timeText.textContent = formatTime(item.timestamp);

    meta.appendChild(timeText);
    messageElement.appendChild(messageText);
    messageElement.appendChild(meta);

    messagesContainer.appendChild(messageElement);
  });

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
};

const setActiveUser = (user) => {
  selectedUser = user;
  selectedUserName.textContent = `Chat with ${user.name}`;

  Array.from(usersList.querySelectorAll('.user-item')).forEach((item) => {
    item.classList.toggle('active', item.dataset.userId === user._id);
  });

  typingFromUser = null;
  updateChatStatus();
};

const renderPresence = () => {
  userItems.forEach((item, userId) => {
    item.classList.toggle('online', onlineUsers.has(String(userId)));
  });
};

const updateChatStatus = () => {
  if (!selectedUser) {
    chatStatus.textContent = '';
    chatStatus.classList.remove('typing');
    return;
  }

  if (typingFromUser && typingFromUser === String(selectedUser._id)) {
    chatStatus.textContent = `${selectedUser.name} is typing\u2026`;
    chatStatus.classList.add('typing');
    return;
  }

  chatStatus.classList.remove('typing');
  chatStatus.textContent = onlineUsers.has(String(selectedUser._id)) ? 'Online' : 'Offline';
};

const fetchMessagesPage = async (userId, before = null) => {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });

  if (before) {
    params.set('before', before);
  }

  const response = await fetch(`/api/messages/${userId}?${params.toString()}`, {
    headers: authHeaders,
  });

  if (response.status === 401) {
    localStorage.clear();
    window.location.href = '/login.html';
    return null;
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || 'Unable to load conversation.');
  }

  return data;
};

const loadConversation = async (user) => {
  chatError.textContent = '';
  setActiveUser(user);

  if (unreadCounts.delete(user._id)) {
    renderUnreadBadges();
  }

  socket.emit('conversationOpened', { userId: user._id });

  try {
    const data = await fetchMessagesPage(user._id);

    if (!data) {
      return;
    }

    conversationCache.set(user._id, data.messages);
    pageCursors.set(user._id, data.nextCursor);
    renderMessages(data.messages);
  } catch (error) {
    chatError.textContent = 'Unable to load conversation right now.';
  }
};

const loadOlderMessages = async () => {
  if (!selectedUser) {
    return;
  }

  const userId = String(selectedUser._id);
  const cursor = pageCursors.get(userId);

  if (!cursor || loadingOlder.has(userId)) {
    return;
  }

  loadingOlder.add(userId);

  try {
    const data = await fetchMessagesPage(userId, cursor);

    if (!data || !data.messages.length || !selectedUser) {
      return;
    }

    const previousHeight = messagesContainer.scrollHeight;
    const merged = [...data.messages, ...(conversationCache.get(userId) || [])];

    conversationCache.set(userId, merged);
    pageCursors.set(userId, data.nextCursor);

    if (String(selectedUser._id) === userId) {
      renderMessages(merged);
      messagesContainer.scrollTop = messagesContainer.scrollHeight - previousHeight;
    }
  } catch (error) {
    chatError.textContent = 'Unable to load older messages.';
  } finally {
    loadingOlder.delete(userId);
  }
};

messagesContainer.addEventListener('scroll', () => {
  if (messagesContainer.scrollTop <= 4) {
    loadOlderMessages();
  }
});

const renderUnreadBadges = () => {
  userItems.forEach((item, userId) => {
    const badge = item.querySelector('.unread-badge');

    if (!badge) {
      return;
    }

    const count = unreadCounts.get(userId) || 0;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? '99+' : String(count);
  });
};

const loadUsers = async () => {
  try {
    const response = await fetch('/api/users', {
      headers: authHeaders,
    });

    if (response.status === 401) {
      localStorage.clear();
      window.location.href = '/login.html';
      return;
    }

    const users = await response.json();

    if (!response.ok) {
      chatError.textContent = users.message || 'Unable to load users.';
      return;
    }

    usersList.innerHTML = '';

    users.forEach((user) => {
      const item = document.createElement('li');
      item.className = 'user-item';
      item.dataset.userId = user._id;

      const name = document.createElement('strong');
      name.textContent = user.name;

      const presenceDot = document.createElement('span');
      presenceDot.className = 'presence-dot';
      presenceDot.title = 'Offline';
      name.appendChild(presenceDot);

      const lineBreak = document.createElement('br');

      const email = document.createElement('small');
      email.textContent = user.email;

      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.hidden = true;

      item.appendChild(name);
      item.appendChild(lineBreak);
      item.appendChild(email);
      item.appendChild(badge);
      item.addEventListener('click', () => loadConversation(user));
      usersList.appendChild(item);
      userItems.set(user._id, item);
    });

    renderUnreadBadges();
    renderPresence();
    updateChatStatus();
  } catch (error) {
    chatError.textContent = 'Unable to fetch users right now.';
  }
};

socket.on('messageReceived', (newMessage) => {
  const otherUserId =
    String(newMessage.sender) === String(currentUser.id)
      ? String(newMessage.receiver)
      : String(newMessage.sender);

  const existingConversation = conversationCache.get(otherUserId) || [];
  const updatedConversation = [...existingConversation, newMessage];
  conversationCache.set(otherUserId, updatedConversation);

  const isOpen = selectedUser && String(selectedUser._id) === String(otherUserId);

  if (isOpen) {
    renderMessages(updatedConversation);

    if (!newMessage.isOwnMessage) {
      // Visible on screen right now, so it counts as seen.
      socket.emit('conversationOpened', { userId: otherUserId });
    }

    return;
  }

  if (!newMessage.isOwnMessage) {
    unreadCounts.set(otherUserId, (unreadCounts.get(otherUserId) || 0) + 1);
    renderUnreadBadges();
  }
});

socket.on('messageStatus', (update) => {
  const idSet = new Set((update.messageIds || []).map(String));

  if (!idSet.size || !update.status) {
    return;
  }

  let touched = false;

  conversationCache.forEach((messages, key) => {
    let changed = false;

    const nextMessages = messages.map((item) => {
      if (idSet.has(String(item.id)) && item.status !== update.status) {
        changed = true;
        return { ...item, status: update.status };
      }

      return item;
    });

    if (changed) {
      conversationCache.set(key, nextMessages);
      touched = true;
    }
  });

  if (touched && selectedUser) {
    renderMessages(conversationCache.get(String(selectedUser._id)) || []);
  }
});

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  chatError.textContent = '';

  if (!selectedUser) {
    chatError.textContent = 'Select a user first.';
    return;
  }

  const message = messageInput.value.trim();

  if (!message) {
    chatError.textContent = 'Message cannot be empty.';
    return;
  }

  socket.emit('privateMessage', {
    receiverId: selectedUser._id,
    message,
  });

  stopTypingNotice();
  messageInput.value = '';
  messageInput.focus();
});

const stopTypingNotice = () => {
  clearTimeout(typingEmitTimer);

  if (selectedUser) {
    socket.emit('typing', { receiverId: selectedUser._id, isTyping: false });
  }
};

messageInput.addEventListener('input', () => {
  if (!selectedUser) {
    return;
  }

  socket.emit('typing', { receiverId: selectedUser._id, isTyping: true });
  clearTimeout(typingEmitTimer);

  typingEmitTimer = setTimeout(() => {
    socket.emit('typing', { receiverId: selectedUser._id, isTyping: false });
  }, 2000);
});

logoutButton.addEventListener('click', () => {
  localStorage.removeItem('token');
  localStorage.removeItem('currentUser');
  window.location.href = '/login.html';
});

loadUsers();
