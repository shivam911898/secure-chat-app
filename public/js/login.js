const token = localStorage.getItem('token');
if (token) {
  window.location.href = '/chat.html';
}

const loginForm = document.getElementById('loginForm');
const errorMessage = document.getElementById('errorMessage');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.textContent = '';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json();

    if (!response.ok) {
      errorMessage.textContent = data.message || 'Login failed.';
      return;
    }

    localStorage.setItem('token', data.token);
    localStorage.setItem('currentUser', JSON.stringify(data.user));
    window.location.href = '/chat.html';
  } catch (error) {
    errorMessage.textContent = 'Unable to login right now. Please try again.';
  }
});
