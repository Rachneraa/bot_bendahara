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
