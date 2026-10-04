// Dashboard interactions & live WhatsApp status polling

document.addEventListener('DOMContentLoaded', () => {
  // Modal toggles
  window.openModal = function(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  };

  window.closeModal = function(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  };

  // Close modal when clicking outside
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
      }
    });
  });

  // Salin Pairing Code
  window.copyPairingCode = function(text) {
    navigator.clipboard.writeText(text).then(() => {
      alert('Pairing Code berhasil disalin: ' + text);
    }).catch(err => {
      console.error('Gagal salin teks:', err);
    });
  };

  // Request Pairing Code Manual via Web
  const formPair = document.getElementById('formPairingCode');
  if (formPair) {
    formPair.addEventListener('submit', async (e) => {
      e.preventDefault();
      const phoneInput = document.getElementById('pairingPhone');
      const btn = formPair.querySelector('button[type="submit"]');
      const originalText = btn.innerHTML;

      try {
        btn.disabled = true;
        btn.innerHTML = 'Meminta Kode...';
        const res = await fetch('/api/bot/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumber: phoneInput.value })
        });
        const data = await res.json();
        if (data.success) {
          alert('Pairing code berhasil dibuat! Halaman akan dimuat ulang.');
          window.location.reload();
        } else {
          alert('Gagal: ' + data.message);
        }
      } catch (err) {
        alert('Terjadi kesalahan: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    });
  }

  // Reset Sesi WhatsApp secara bersih
  window.handleResetSession = async function() {
    if (!confirm('Apakah Anda yakin ingin mereset seluruh sesi WhatsApp bot? Tindakan ini akan menghapus sesi lama yang logout / gagal taut.')) {
      return;
    }
    try {
      const res = await fetch('/api/bot/reset-session', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        window.location.reload();
      } else {
        alert('Gagal: ' + data.message);
      }
    } catch (err) {
      alert('Terjadi kesalahan: ' + err.message);
    }
  };

  // Live Countdown Timer untuk Pairing Code (60 detik)
  const activeBox = document.getElementById('activePairingBox');
  if (activeBox) {
    const createdAt = parseInt(activeBox.getAttribute('data-created-at'), 10) || Date.now();
    const countdownEl = document.getElementById('timerSeconds');
    const timerInfoEl = document.getElementById('pairingTimerInfo');

    const updateTimer = () => {
      const elapsed = Math.floor((Date.now() - createdAt) / 1000);
      const remaining = Math.max(0, 60 - elapsed);
      if (countdownEl) countdownEl.innerText = remaining;

      if (remaining <= 0 && timerInfoEl) {
        timerInfoEl.innerHTML = `<span style="color: var(--accent-rose); font-weight: 600;">⚠️ Kode pairing ini telah kadaluarsa! Klik <strong>Minta Kode Baru</strong> untuk mendapatkan kode baru.</span>`;
      }
    };

    updateTimer();
    setInterval(updateTimer, 1000);
  }

  // Polling Status Bot WhatsApp (jika di halaman dashboard)
  const statusContainer = document.getElementById('waStatusContainer');
  if (statusContainer) {
    setInterval(async () => {
      try {
        const res = await fetch('/api/bot/status');
        const data = await res.json();
        
        // Auto refresh jika status berubah dari waiting/disconnected menjadi connected
        const currentStatus = statusContainer.getAttribute('data-status');
        if (currentStatus !== data.status) {
          window.location.reload();
        }
      } catch (e) {
        // Silent polling error
      }
    }, 5000);
  }
});
