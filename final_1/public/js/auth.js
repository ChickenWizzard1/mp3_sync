// Login Formular
document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.innerHTML;

    try {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Einloggen...';

      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username.value,
          password: form.password.value
        })
      });

      const data = await response.json();

      if (response.ok) {
        showSuccess('Erfolgreich eingeloggt');
        setTimeout(() => {
          window.location.href = '/index.html';
        }, 1000);
      } else {
        showError(data.error || 'Login fehlgeschlagen');
      }
    } catch (error) {
      showError('Netzwerkfehler. Bitte versuchen Sie es später erneut.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText;
    }
});

// Registrierungsformular
document.getElementById('registerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.innerHTML;

    try {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Registrieren...';

      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username.value,
          password: form.password.value
        })
      });

      const data = await response.json();

      if (response.ok) {
        showSuccess('Registrierung erfolgreich! Sie werden zum Login weitergeleitet.');
        setTimeout(() => {
          window.location.href = '/login.html';
        }, 1500);
      } else {
        showError(data.error || 'Registrierung fehlgeschlagen');
      }
    } catch (error) {
      showError('Netzwerkfehler. Bitte versuchen Sie es später erneut.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText;
    }
});

function showError(message) {
  const errorElement = document.createElement('div');
  errorElement.className = 'error-message';
  errorElement.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${message}`;
  
  document.body.appendChild(errorElement);
  setTimeout(() => {
    errorElement.remove();
  }, 3000);
}

function showSuccess(message) {
  const successElement = document.createElement('div');
  successElement.className = 'success-message';
  successElement.innerHTML = `<i class="fas fa-check-circle"></i> ${message}`;
  
  document.body.appendChild(successElement);
  setTimeout(() => {
    successElement.remove();
  }, 3000);
}

// Wenn bereits eingeloggt, zur Startseite weiterleiten
if (document.cookie.includes('token') &&
    (window.location.pathname === '/login.html' ||
     window.location.pathname === '/register.html')) {
  window.location.href = '/index.html';
}