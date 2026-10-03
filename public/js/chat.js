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
const logoutButton = document.getElementById('logoutButton');

let selectedUser = null;
const conversationCache = new Map();

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

socket.on('chatError', (payload) => {
  chatError.textContent = payload.message || 'Chat error occurred.';
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

    const timeText = document.createElement('span');
    timeText.textContent = formatTime(item.timestamp);

    messageElement.appendChild(messageText);
    messageElement.appendChild(timeText);

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
};

const loadConversation = async (user) => {
  chatError.textContent = '';
  setActiveUser(user);

  try {
    const response = await fetch(`/api/messages/${user._id}`, {
      headers: authHeaders,
    });

    if (response.status === 401) {
      localStorage.clear();
      window.location.href = '/login.html';
      return;
    }

    const data = await response.json();

    if (!response.ok) {
      chatError.textContent = data.message || 'Unable to load conversation.';
      return;
    }

    conversationCache.set(user._id, data);
    renderMessages(data);
  } catch (error) {
    chatError.textContent = 'Unable to load conversation right now.';
  }
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

      const lineBreak = document.createElement('br');

      const email = document.createElement('small');
      email.textContent = user.email;

      item.appendChild(name);
      item.appendChild(lineBreak);
      item.appendChild(email);
      item.addEventListener('click', () => loadConversation(user));
      usersList.appendChild(item);
    });
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

  if (selectedUser && selectedUser._id === otherUserId) {
    renderMessages(updatedConversation);
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

  messageInput.value = '';
  messageInput.focus();
});

logoutButton.addEventListener('click', () => {
  localStorage.removeItem('token');
  localStorage.removeItem('currentUser');
  window.location.href = '/login.html';
});

loadUsers();
