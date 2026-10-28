const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const password = document.getElementById('password');
const togglePassword = document.getElementById('toggle-password');
const authToggle = document.getElementById('auth-toggle');
let mode = 'login';
togglePassword.addEventListener('click', event => {
  const showing = password.type === 'text';
  password.type = showing ? 'password' : 'text';
  event.currentTarget.textContent = showing ? 'Show' : 'Hide';
  event.currentTarget.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});
authToggle.addEventListener('click', () => {
  mode = mode === 'login' ? 'register' : 'login';
  const registering = mode === 'register';
  document.getElementById('auth-title').textContent = registering ? 'Create your account' : 'Welcome back';
  document.getElementById('auth-hint').textContent = registering ? 'Create a private space for your files.' : 'Sign in to manage your shared files.';
  document.getElementById('auth-submit').innerHTML = registering ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  authToggle.textContent = registering ? 'Already have an account? Sign in' : 'Need an account? Create one';
  password.autocomplete = registering ? 'new-password' : 'current-password';
  password.minLength = registering ? 12 : 1;
  document.getElementById('password-note').hidden = !registering;
  errorBox.textContent = '';
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const response = await fetch(mode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: password.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || (mode === 'register' ? 'Registration failed.' : 'Sign-in failed.'));
    location.replace('/');
  } catch (error) {
    errorBox.textContent = error.message === 'Failed to fetch' ? 'Cannot reach the server. Check that Drop Space is running.' : error.message;
  } finally { button.disabled = false; }
});
