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
const userSearch = document.getElementById('userSearch');
const userListHint = document.getElementById('userListHint');
const messageSearch = document.getElementById('messageSearch');
const searchMeta = document.getElementById('searchMeta');
const callButton = document.getElementById('callButton');
const callOverlay = document.getElementById('callOverlay');
const callLabel = document.getElementById('callLabel');
const callError = document.getElementById('callError');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const acceptCall = document.getElementById('acceptCall');
const rejectCall = document.getElementById('rejectCall');
const hangupCall = document.getElementById('hangupCall');
const attachButton = document.getElementById('attachButton');
const fileInput = document.getElementById('fileInput');
const attachmentChip = document.getElementById('attachmentChip');
const attachmentName = document.getElementById('attachmentName');
const removeAttachment = document.getElementById('removeAttachment');
const contextChip = document.getElementById('contextChip');
const contextLabel = document.getElementById('contextLabel');
const removeContext = document.getElementById('removeContext');

const PAGE_SIZE = 50;

let selectedUser = null;
const conversationCache = new Map();
const unreadCounts = new Map();
const userItems = new Map();
const pageCursors = new Map();
const loadingOlder = new Set();
const onlineUsers = new Set();
const knownUsers = new Map();
const missedCalls = new Map();
let activeUserSearch = '';
let messageQuery = '';
let searchResults = null;
let messageSearchSeq = 0;
let pendingAttachment = null;
let replyTarget = null;
let editingTarget = null;
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
  updateCallButton();
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
  updateCallButton();
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

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
];

const attachmentUrls = new Map();

const formatSize = (bytes) => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${bytes} B`;
};

const clearAttachment = () => {
  pendingAttachment = null;
  fileInput.value = '';
  attachmentChip.hidden = true;
  attachmentName.textContent = '';
};

const clearContext = () => {
  replyTarget = null;
  editingTarget = null;
  contextChip.hidden = true;
  contextLabel.textContent = '';
};

const previewText = (item) => {
  const text = (item.message || (item.attachment && item.attachment.name) || '').trim();
  return text.length > 40 ? `${text.slice(0, 40)}\u2026` : text;
};

const setReplyTarget = (item) => {
  editingTarget = null;
  replyTarget = item;
  const author = item.isOwnMessage ? 'you' : selectedUser ? selectedUser.name : 'them';
  contextLabel.textContent = `Replying to ${author}: ${previewText(item)}`;
  contextChip.hidden = false;
  messageInput.focus();
};

const setEditingTarget = (item) => {
  if (!item.message) {
    return;
  }

  replyTarget = null;
  editingTarget = item;
  contextLabel.textContent = `Editing: ${previewText(item)}`;
  contextChip.hidden = false;
  messageInput.value = item.message;
  messageInput.focus();
};

const setAttachment = (file) => {
  if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
    chatError.textContent = 'This file type is not allowed.';
    return;
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    chatError.textContent = 'Attachment is too large (max 4 MB).';
    return;
  }

  const reader = new FileReader();

  reader.onload = () => {
    pendingAttachment = { name: file.name, type: file.type, data: reader.result };
    attachmentName.textContent = `${file.name} \u00b7 ${formatSize(file.size)}`;
    attachmentChip.hidden = false;
    chatError.textContent = '';
  };

  reader.onerror = () => {
    chatError.textContent = 'Could not read that file.';
  };

  reader.readAsDataURL(file);
};

// Attachment bytes are fetched on demand (the route requires a token) and the
// resulting blob URL is cached so re-renders do not re-download.
const resolveAttachment = async (item) => {
  const key = String(item.id);

  if (attachmentUrls.has(key)) {
    return attachmentUrls.get(key);
  }

  try {
    const response = await fetch(item.attachment.url, { headers: authHeaders });

    if (!response.ok) {
      return null;
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    attachmentUrls.set(key, objectUrl);
    return objectUrl;
  } catch (error) {
    return null;
  }
};

const renderAttachment = (item, container) => {
  if (!item.attachment) {
    return;
  }

  const meta = item.attachment;

  if (meta.contentType && meta.contentType.startsWith('image/')) {
    const image = document.createElement('img');
    image.className = 'message-image';
    image.alt = meta.name;
    container.appendChild(image);

    resolveAttachment(item).then((objectUrl) => {
      if (objectUrl) {
        image.src = objectUrl;
      }
    });

    return;
  }

  const link = document.createElement('a');
  link.className = 'message-file';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = `${meta.name} (${formatSize(meta.size || 0)})`;
  container.appendChild(link);

  resolveAttachment(item).then((objectUrl) => {
    if (objectUrl) {
      link.href = objectUrl;
    }
  });
};

const renderMessages = (messages) => {
  messagesContainer.innerHTML = '';

  if (!messages.length) {
    messagesContainer.innerHTML = messageQuery
      ? '<p class="subtitle">No messages match your search.</p>'
      : '<p class="subtitle">No messages yet.</p>';
    return;
  }

  messages.forEach((item) => {
    const messageElement = document.createElement('article');
    messageElement.className = `message ${item.isOwnMessage ? 'own' : ''}`;

    if (item.replyTo) {
      const quote = document.createElement('div');
      quote.className = 'reply-quote';

      const quoteAuthor = document.createElement('span');
      quoteAuthor.className = 'reply-quote-author';
      quoteAuthor.textContent =
        String(item.replyTo.sender) === String(currentUser.id)
          ? 'You'
          : selectedUser && String(item.replyTo.sender) === String(selectedUser._id)
            ? selectedUser.name
            : 'Message';

      const quoteText = document.createElement('p');
      quoteText.className = 'reply-quote-text';
      quoteText.textContent = item.replyTo.text;

      quote.appendChild(quoteAuthor);
      quote.appendChild(quoteText);
      messageElement.appendChild(quote);
    }

    if (item.message) {
      const messageText = document.createElement('p');
      messageText.textContent = item.message;
      messageElement.appendChild(messageText);
    }

    renderAttachment(item, messageElement);

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

    if (item.editedAt) {
      const editedFlag = document.createElement('span');
      editedFlag.className = 'edited-flag';
      editedFlag.textContent = 'edited';
      meta.appendChild(editedFlag);
    }

    const actions = document.createElement('span');
    actions.className = 'message-actions';

    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.className = 'message-action';
    replyButton.textContent = 'Reply';
    replyButton.title = 'Reply to this message';
    replyButton.addEventListener('click', () => setReplyTarget(item));
    actions.appendChild(replyButton);

    if (item.isOwnMessage && item.message) {
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'message-action';
      editButton.textContent = 'Edit';
      editButton.title = 'Edit this message';
      editButton.addEventListener('click', () => setEditingTarget(item));
      actions.appendChild(editButton);
    }

    meta.appendChild(actions);
    messageElement.appendChild(meta);

    messagesContainer.appendChild(messageElement);
  });

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
};

const getVisibleMessages = () => {
  const all = selectedUser ? conversationCache.get(String(selectedUser._id)) || [] : [];

  if (!messageQuery) {
    return all;
  }

  // Server results cover the whole conversation (decrypted on demand);
  // until they land we show the client-side filter of what is loaded.
  if (searchResults) {
    return searchResults;
  }

  const needle = messageQuery.toLowerCase();
  return all.filter((item) => item.message.toLowerCase().includes(needle));
};

const renderCurrent = () => {
  const visible = getVisibleMessages();
  renderMessages(visible);

  if (messageQuery) {
    if (searchResults) {
      searchMeta.textContent = searchResults.length
        ? `${searchResults.length} match${searchResults.length === 1 ? '' : 'es'} in this conversation`
        : 'No matches in this conversation';
    } else {
      const total = selectedUser
        ? (conversationCache.get(String(selectedUser._id)) || []).length
        : 0;
      searchMeta.textContent = `${visible.length} of ${total} loaded messages match`;
    }
  } else {
    searchMeta.textContent = '';
  }
};

const setActiveUser = (user) => {
  selectedUser = user;
  selectedUserName.textContent = `Chat with ${user.name}`;

  Array.from(usersList.querySelectorAll('.user-item')).forEach((item) => {
    item.classList.toggle('active', item.dataset.userId === user._id);
  });

  typingFromUser = null;
  updateChatStatus();
  updateCallButton();
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
  clearContext();

  // Search is scoped to the conversation that is open.
  messageSearchSeq += 1;
  messageQuery = '';
  searchResults = null;
  messageSearch.value = '';
  searchMeta.textContent = '';

  setActiveUser(user);

  if (unreadCounts.delete(user._id)) {
    renderUnreadBadges();
  }

  if (missedCalls.delete(String(user._id))) {
    renderMissedTags();
    fetch('/api/calls/seen', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: user._id }),
    });
  }

  socket.emit('conversationOpened', { userId: user._id });

  try {
    const data = await fetchMessagesPage(user._id);

    if (!data) {
      return;
    }

    conversationCache.set(user._id, data.messages);
    pageCursors.set(user._id, data.nextCursor);
    renderCurrent();
  } catch (error) {
    chatError.textContent = 'Unable to load conversation right now.';
  }
};

const loadOlderMessages = async () => {
  if (!selectedUser || messageQuery) {
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
      renderCurrent();
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

const renderMissedTags = () => {
  userItems.forEach((item, userId) => {
    const tag = item.querySelector('.missed-tag');

    if (!tag) {
      return;
    }

    const count = missedCalls.get(String(userId)) || 0;
    tag.hidden = count === 0;
    tag.textContent = count > 1 ? `Missed calls (${count})` : 'Missed call';
  });
};

const loadMissedCalls = async () => {
  try {
    const response = await fetch('/api/calls/missed', { headers: authHeaders });

    if (response.status === 401) {
      localStorage.clear();
      window.location.href = '/login.html';
      return;
    }

    const data = await response.json();

    if (!response.ok) {
      return;
    }

    missedCalls.clear();

    data.forEach((call) => {
      const key = String(call.from);
      missedCalls.set(key, (missedCalls.get(key) || 0) + 1);
    });

    renderMissedTags();
  } catch (error) {
    // The tag is a nicety; a failed fetch should not break the page.
  }
};

const loadUsers = async (search = '') => {
  try {
    const url = search ? `/api/users?search=${encodeURIComponent(search)}` : '/api/users';
    const response = await fetch(url, {
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
    userItems.clear();

    users.forEach((user) => {
      knownUsers.set(String(user._id), user);
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

      const missedTag = document.createElement('span');
      missedTag.className = 'missed-tag';
      missedTag.hidden = true;

      item.appendChild(name);
      item.appendChild(lineBreak);
      item.appendChild(email);
      item.appendChild(missedTag);
      item.appendChild(badge);
      item.addEventListener('click', () => loadConversation(user));
      usersList.appendChild(item);
      userItems.set(user._id, item);
    });

    renderUnreadBadges();
    renderMissedTags();
    renderPresence();
    updateChatStatus();
    updateCallButton();
    userListHint.hidden = users.length > 0;

    // Re-highlight the conversation that is currently open.
    if (selectedUser) {
      const activeItem = userItems.get(String(selectedUser._id));

      if (activeItem) {
        activeItem.classList.add('active');
      }
    }
  } catch (error) {
    chatError.textContent = 'Unable to fetch users right now.';
  }
};

socket.on('callMissed', ({ from } = {}) => {
  if (!from) {
    return;
  }

  const key = String(from);
  missedCalls.set(key, (missedCalls.get(key) || 0) + 1);

  if (!knownUsers.has(key)) {
    loadUsers(activeUserSearch);
  }

  renderMissedTags();
});

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
    renderCurrent();

    if (!newMessage.isOwnMessage) {
      // Visible on screen right now, so it counts as seen.
      socket.emit('conversationOpened', { userId: otherUserId });
    }

    return;
  }

  if (!knownUsers.has(otherUserId)) {
    // A message from someone outside my contact list: show them now.
    loadUsers(activeUserSearch);
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
    renderCurrent();
  }
});

socket.on('messageEdited', (edited) => {
  let touched = false;

  conversationCache.forEach((messages, key) => {
    const index = messages.findIndex((item) => String(item.id) === String(edited.id));

    if (index === -1) {
      return;
    }

    const next = [...messages];
    next[index] = { ...next[index], message: edited.message, editedAt: edited.editedAt };
    conversationCache.set(key, next);
    touched = true;
  });

  if (touched && selectedUser) {
    renderCurrent();
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

  if (!message && !pendingAttachment) {
    chatError.textContent = 'Message cannot be empty.';
    return;
  }

  if (editingTarget) {
    if (!message) {
      chatError.textContent = 'Message cannot be empty.';
      return;
    }

    socket.emit('editMessage', { messageId: String(editingTarget.id), text: message });
    clearContext();
    stopTypingNotice();
    messageInput.value = '';
    messageInput.focus();
    return;
  }

  socket.emit('privateMessage', {
    receiverId: selectedUser._id,
    message,
    attachment: pendingAttachment,
    replyTo: replyTarget ? String(replyTarget.id) : undefined,
  });

  clearContext();
  clearAttachment();
  stopTypingNotice();
  messageInput.value = '';
  messageInput.focus();
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (replyTarget || editingTarget)) {
    clearContext();
    messageInput.value = '';
  }
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

// ---------- sidebar people search ----------
let userSearchTimer = null;

userSearch.addEventListener('input', () => {
  activeUserSearch = userSearch.value.trim();
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(() => loadUsers(activeUserSearch), 250);
});

// ---------- message search ----------
// The server decrypts on demand, so this covers messages the client never
// loaded; the client-side filter keeps things instant while the request runs.
let messageSearchTimer = null;

messageSearch.addEventListener('input', () => {
  clearTimeout(messageSearchTimer);
  messageSearchTimer = setTimeout(() => {
    messageQuery = messageSearch.value.trim();
    searchResults = null;
    renderCurrent();

    if (messageQuery.length < 2 || !selectedUser) {
      return;
    }

    const userId = String(selectedUser._id);
    const seq = (messageSearchSeq += 1);

    fetch(`/api/messages/${userId}/search?q=${encodeURIComponent(messageQuery)}`, {
      headers: authHeaders,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('no match'))))
      .then((data) => {
        if (seq !== messageSearchSeq || !selectedUser || String(selectedUser._id) !== userId) {
          return; // stale: user typed more or switched conversations
        }

        searchResults = data.results;
        renderCurrent();
      })
      .catch(() => {
        // Keep the client-side filter of loaded messages.
      });
  }, 150);
});

// ---------- video calling (WebRTC over the existing socket) ----------
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let activeCall = null;
let ringTimer = null;

const userNameFor = (userId) => {
  const known = knownUsers.get(String(userId));

  if (known) {
    return known.name;
  }

  if (selectedUser && String(selectedUser._id) === String(userId)) {
    return selectedUser.name;
  }

  return 'the other person';
};

const updateCallButton = () => {
  const canCall = Boolean(selectedUser) && onlineUsers.has(String(selectedUser._id)) && !activeCall;
  callButton.disabled = !canCall;
  callButton.textContent = activeCall ? 'In call' : 'Video call';
};

const resetCallUi = () => {
  callOverlay.hidden = true;
  acceptCall.hidden = true;
  rejectCall.hidden = true;
  hangupCall.hidden = true;
  callLabel.textContent = 'Starting call\u2026';
  callError.textContent = '';
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
};

const closeCall = ({ message = '', notifyPeer = false } = {}) => {
  if (!activeCall) {
    return;
  }

  const { id, peerId, pc, stream } = activeCall;
  activeCall = null;
  clearTimeout(ringTimer);

  if (notifyPeer) {
    socket.emit('call:hangup', { to: peerId, callId: id });
  }

  if (pc) {
    try {
      pc.close();
    } catch (error) {
      // already closed
    }
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }

  resetCallUi();
  updateCallButton();

  if (message) {
    chatError.textContent = message;
  }
};

const flushPendingIce = async () => {
  if (!activeCall || !activeCall.pc) {
    return;
  }

  const queued = activeCall.pendingIce.splice(0);

  for (const candidate of queued) {
    if (!activeCall || !activeCall.pc) {
      return;
    }

    await activeCall.pc.addIceCandidate(candidate);
  }
};

const handleSignal = async (data = {}) => {
  if (!activeCall) {
    return;
  }

  if (data.sdp) {
    // The offer can arrive before the callee accepts, so park it until then.
    if (!activeCall.pc) {
      activeCall.pendingSignals.push(data);
      return;
    }

    await activeCall.pc.setRemoteDescription(data.sdp);
    activeCall.remoteDescSet = true;
    await flushPendingIce();

    if (data.sdp.type === 'offer') {
      const answer = await activeCall.pc.createAnswer();
      await activeCall.pc.setLocalDescription(answer);
      socket.emit('call:signal', {
        to: activeCall.peerId,
        callId: activeCall.id,
        data: { sdp: { type: answer.type, sdp: answer.sdp } },
      });
    }

    const queued = activeCall.pendingSignals.splice(0);

    for (const item of queued) {
      await handleSignal(item);
    }

    return;
  }

  if (data.candidate) {
    if (!activeCall.pc || !activeCall.remoteDescSet) {
      activeCall.pendingIce.push(data.candidate);
      return;
    }

    await activeCall.pc.addIceCandidate(data.candidate);
  }
};

const createPeerConnection = () => {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  activeCall.stream.getTracks().forEach((track) => {
    pc.addTrack(track, activeCall.stream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate && activeCall) {
      socket.emit('call:signal', {
        to: activeCall.peerId,
        callId: activeCall.id,
        data: {
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
          },
        },
      });
    }
  };

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];

    if (activeCall) {
      callLabel.textContent = `In call with ${userNameFor(activeCall.peerId)}`;
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      closeCall({ message: 'Call failed.' });
    }
  };

  activeCall.pc = pc;
  return pc;
};

const ensureLocalMedia = async () => {
  if (activeCall.stream) {
    return;
  }

  activeCall.stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true,
  });
  localVideo.srcObject = activeCall.stream;
};

const startVideoCall = async () => {
  if (!selectedUser) {
    chatError.textContent = 'Select a user first.';
    return;
  }

  if (activeCall) {
    chatError.textContent = 'You are already in a call.';
    return;
  }

  if (!onlineUsers.has(String(selectedUser._id))) {
    chatError.textContent = 'They are offline right now.';
    return;
  }

  const peerId = String(selectedUser._id);

  activeCall = {
    id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    peerId,
    role: 'caller',
    pc: null,
    stream: null,
    pendingIce: [],
    pendingSignals: [],
    remoteDescSet: false,
  };

  callOverlay.hidden = false;
  acceptCall.hidden = true;
  rejectCall.hidden = true;
  hangupCall.hidden = false;
  callLabel.textContent = `Calling ${userNameFor(peerId)}\u2026`;
  callError.textContent = '';
  chatError.textContent = '';
  updateCallButton();

  socket.emit('call:invite', { to: peerId, callId: activeCall.id });

  ringTimer = setTimeout(() => {
    if (activeCall && activeCall.role === 'caller') {
      // Tell the server so the unanswered call is recorded as missed.
      closeCall({ message: 'No answer.', notifyPeer: true });
    }
  }, 30000);

  try {
    await ensureLocalMedia();
    createPeerConnection();

    const offer = await activeCall.pc.createOffer();
    await activeCall.pc.setLocalDescription(offer);

    socket.emit('call:signal', {
      to: activeCall.peerId,
      callId: activeCall.id,
      data: { sdp: { type: offer.type, sdp: offer.sdp } },
    });
  } catch (error) {
    closeCall({ message: 'Camera or microphone is unavailable.' });
  }
};

socket.on('call:invite', (payload = {}) => {
  const from = String(payload.from || '');

  if (!from || !payload.callId) {
    return;
  }

  if (activeCall) {
    socket.emit('call:reject', { to: from, callId: payload.callId });
    return;
  }

  activeCall = {
    id: payload.callId,
    peerId: from,
    role: 'callee',
    pc: null,
    stream: null,
    pendingIce: [],
    pendingSignals: [],
    remoteDescSet: false,
  };

  callOverlay.hidden = false;
  acceptCall.hidden = false;
  rejectCall.hidden = false;
  hangupCall.hidden = true;
  callLabel.textContent = `${userNameFor(from)} is calling\u2026`;
  callError.textContent = '';
  chatError.textContent = '';
  updateCallButton();
});

socket.on('call:accept', (payload = {}) => {
  if (!activeCall || payload.callId !== activeCall.id) {
    return;
  }

  clearTimeout(ringTimer);
  callLabel.textContent = 'Connecting\u2026';
});

socket.on('call:reject', (payload = {}) => {
  if (!activeCall || (payload.callId && payload.callId !== activeCall.id)) {
    return;
  }

  closeCall({ message: 'Call declined.' });
});

socket.on('call:hangup', (payload = {}) => {
  if (!activeCall || (payload.callId && payload.callId !== activeCall.id)) {
    return;
  }

  closeCall({ message: 'Call ended.' });
});

socket.on('call:signal', (payload = {}) => {
  if (!activeCall || payload.callId !== activeCall.id) {
    return;
  }

  handleSignal(payload.data).catch(() => {
    closeCall({ message: 'Call failed.' });
  });
});

callButton.addEventListener('click', startVideoCall);

acceptCall.addEventListener('click', async () => {
  if (!activeCall) {
    return;
  }

  acceptCall.hidden = true;
  rejectCall.hidden = true;
  hangupCall.hidden = false;
  callLabel.textContent = `Connecting to ${userNameFor(activeCall.peerId)}\u2026`;
  chatError.textContent = '';

  try {
    await ensureLocalMedia();
    createPeerConnection();
    socket.emit('call:accept', { to: activeCall.peerId, callId: activeCall.id });

    const queued = activeCall.pendingSignals.splice(0);

    for (const item of queued) {
      await handleSignal(item);
    }

    await flushPendingIce();
  } catch (error) {
    closeCall({ message: 'Camera or microphone is unavailable.', notifyPeer: true });
  }
});

rejectCall.addEventListener('click', () => {
  if (!activeCall) {
    return;
  }

  socket.emit('call:reject', { to: activeCall.peerId, callId: activeCall.id });
  closeCall({ message: 'Call declined.' });
});

hangupCall.addEventListener('click', () => {
  closeCall({ message: 'Call ended.', notifyPeer: true });
});

attachButton.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];

  if (file) {
    setAttachment(file);
  }
});

removeAttachment.addEventListener('click', clearAttachment);

removeContext.addEventListener('click', () => {
  clearContext();
  messageInput.value = '';
  messageInput.focus();
});

loadUsers();
loadMissedCalls();
