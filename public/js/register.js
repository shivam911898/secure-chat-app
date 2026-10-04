const existingToken = localStorage.getItem('token');
if (existingToken) {
  window.location.href = '/chat.html';
}

const registerForm = document.getElementById('registerForm');
const errorMessage = document.getElementById('errorMessage');

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.textContent = '';

  const name = document.getElementById('name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });

    const data = await response.json();

    if (!response.ok) {
      errorMessage.textContent = data.message || 'Registration failed.';
      return;
    }

    localStorage.setItem('token', data.token);
    localStorage.setItem('currentUser', JSON.stringify(data.user));
    window.location.href = '/chat.html';
  } catch (error) {
    errorMessage.textContent = 'Unable to register right now. Please try again.';
  }
});
