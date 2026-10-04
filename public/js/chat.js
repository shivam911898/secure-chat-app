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

const PAGE_SIZE = 50;

let selectedUser = null;
const conversationCache = new Map();
const unreadCounts = new Map();
const userItems = new Map();
const pageCursors = new Map();
const loadingOlder = new Set();
const onlineUsers = new Set();
const knownUsers = new Map();
let activeUserSearch = '';
let messageQuery = '';
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

const getVisibleMessages = () => {
  const all = selectedUser ? conversationCache.get(String(selectedUser._id)) || [] : [];

  if (!messageQuery) {
    return all;
  }

  const needle = messageQuery.toLowerCase();
  return all.filter((item) => item.message.toLowerCase().includes(needle));
};

const renderCurrent = () => {
  const visible = getVisibleMessages();
  renderMessages(visible);

  if (messageQuery) {
    const total = selectedUser
      ? (conversationCache.get(String(selectedUser._id)) || []).length
      : 0;
    searchMeta.textContent = `${visible.length} of ${total} loaded messages match`;
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

// ---------- sidebar people search ----------
let userSearchTimer = null;

userSearch.addEventListener('input', () => {
  activeUserSearch = userSearch.value.trim();
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(() => loadUsers(activeUserSearch), 250);
});

// ---------- message search (client side; content is encrypted at rest) ----------
let messageSearchTimer = null;

messageSearch.addEventListener('input', () => {
  clearTimeout(messageSearchTimer);
  messageSearchTimer = setTimeout(() => {
    messageQuery = messageSearch.value.trim();
    renderCurrent();
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
      closeCall({ message: 'No answer.' });
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

loadUsers();
