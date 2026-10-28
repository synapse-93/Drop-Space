const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const password = document.getElementById('password');
document.getElementById('toggle-password').addEventListener('click', event => {
  const showing = password.type === 'text';
  password.type = showing ? 'password' : 'text';
  event.currentTarget.textContent = showing ? 'Show' : 'Hide';
  event.currentTarget.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  errorBox.textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: form.username.value, password: password.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign-in failed.');
    location.replace('/');
  } catch (error) {
    errorBox.textContent = error.message;
    password.value = '';
    password.focus();
  } finally { button.disabled = false; }
});
