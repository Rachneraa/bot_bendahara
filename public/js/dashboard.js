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
        btn.innerHTML = 'Meminta Kode ke WhatsApp...';
        const res = await fetch('/api/bot/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumber: phoneInput.value })
        });
        const data = await res.json();
        if (data.success && data.code) {
          // Tampilkan langsung di dalam modal tanpa perlu reload halaman!
          const resultBox = document.getElementById('modalPairingResult');
          const codeEl = document.getElementById('modalCodeDisplay');
          const secondsEl = document.getElementById('modalSeconds');
          const copyBtn = document.getElementById('btnModalCopyCode');

          if (resultBox && codeEl) {
            codeEl.innerText = data.code;
            resultBox.style.display = 'block';

            if (copyBtn) {
              copyBtn.onclick = () => window.copyPairingCode(data.code);
            }

            let timeLeft = 60;
            if (secondsEl) secondsEl.innerText = timeLeft;
            if (window._pairingModalInterval) clearInterval(window._pairingModalInterval);
            window._pairingModalInterval = setInterval(() => {
              timeLeft--;
              if (secondsEl) secondsEl.innerText = Math.max(0, timeLeft);
              if (timeLeft <= 0) {
                clearInterval(window._pairingModalInterval);
                const info = document.getElementById('modalCountdown');
                if (info) info.innerHTML = '<span style="color: var(--accent-rose); font-weight: 700;">⚠️ Kode telah kadaluarsa! Klik tombol Dapatkan Pairing Code lagi.</span>';
              }
            }, 1000);
          }
        } else {
          alert('Gagal: ' + (data.message || 'Tidak dapat membuat kode pairing.'));
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

  // Live Countdown Timer untuk Pairing Code di Dashboard Card (60 detik)
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

  // Tab Switcher Metode Pairing (Code vs QR)
  window.switchPairMethod = function(method) {
    const paneCode = document.getElementById('panePairCode');
    const paneQR = document.getElementById('panePairQR');
    const btnCode = document.getElementById('tabBtnPairCode');
    const btnQR = document.getElementById('tabBtnPairQR');
    if (method === 'qr') {
      if (paneCode) paneCode.style.display = 'none';
      if (paneQR) paneQR.style.display = 'block';
      if (btnCode) btnCode.className = 'btn btn-secondary btn-sm';
      if (btnQR) btnQR.className = 'btn btn-primary btn-sm';
    } else {
      if (paneCode) paneCode.style.display = 'block';
      if (paneQR) paneQR.style.display = 'none';
      if (btnCode) btnCode.className = 'btn btn-primary btn-sm';
      if (btnQR) btnQR.className = 'btn btn-secondary btn-sm';
    }
  };

  // Polling Status Bot WhatsApp (Hanya reload jika status SUDAH CONNECTED)
  const statusContainer = document.getElementById('waStatusContainer');
  if (statusContainer) {
    setInterval(async () => {
      try {
        const res = await fetch('/api/bot/status');
        const data = await res.json();

        // Update QR Code secara live jika tersedia
        const qrImg = document.getElementById('qrImageTag');
        const qrContainer = document.getElementById('qrContainer');
        const qrLoading = document.getElementById('qrLoadingText');
        if (data.qr && qrImg) {
          const newSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(data.qr);
          if (qrImg.src !== newSrc) {
            qrImg.src = newSrc;
          }
          if (qrContainer) qrContainer.style.display = 'block';
          if (qrLoading) qrLoading.style.display = 'none';
        }

        const currentStatus = statusContainer.getAttribute('data-status');
        // Hanya reload ketika koneksi sukses tersambung (connected)
        if (data.status === 'connected' && currentStatus !== 'connected') {
          window.location.reload();
        }
      } catch (e) {
        // Silent polling error
      }
    }, 4000);
  }
});
