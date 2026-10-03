// Utility format mata uang Rupiah dan tanggal waktu Indonesia

export function formatRupiah(number) {
  const num = Number(number) || 0;
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(num);
}

export function formatTime(timeStr) {
  if (!timeStr) return '';
  // format HH:mm
  return timeStr.slice(0, 5);
}

export function getIndonesianDayName(date = new Date()) {
  const days = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];
  return days[date.getDay()];
}

export function getWeekNumber(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return { week: weekNo, year: date.getUTCFullYear() };
}

export function cleanPhoneNumber(phone) {
  if (!phone) return '';
  // Buang suffix device WhatsApp Web/Multi-device (:1, :2) dan domain (@s.whatsapp.net, @lid)
  const base = String(phone).split('@')[0].split(':')[0];
  let cleaned = base.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.slice(1);
  } else if (!cleaned.startsWith('62') && cleaned.length > 0) {
    cleaned = '62' + cleaned;
  }
  return cleaned;
}

export function formatDateIndo(date = new Date()) {
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

export function parseAmount(str) {
  if (!str) return 0;
  let clean = str.toLowerCase().replace(/rp|\.|\,/g, '').trim();
  if (clean.endsWith('k') || clean.endsWith('rb')) {
    clean = clean.replace(/k|rb/g, '');
    return (parseFloat(clean) || 0) * 1000;
  }
  return parseFloat(clean) || 0;
}

export function parseKasEntries(rawText) {
  let body = rawText.replace(/^!bot\s+kas\s+masuk\s*/i, '').trim();
  if (!body) return [];

  let lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  if (lines.length === 1 && lines[0].includes(',')) {
    lines = lines[0].split(',').map(l => l.trim()).filter(Boolean);
  }

  const entries = [];

  for (let rawLine of lines) {
    let cleanLine = rawLine
      .replace(/^[\d]+[\.\)\-\s]+\s*/, '')
      .replace(/^[\*\-\•\–\—]\s*/, '')
      .trim();

    if (!cleanLine) continue;

    const tokens = cleanLine.split(/\s+/);
    let amount = 0;
    let nameTokens = [];
    let foundAmount = false;

    const firstAmount = parseAmount(tokens[0]);
    if (firstAmount > 0 && /\d/.test(tokens[0])) {
      amount = firstAmount;
      nameTokens = tokens.slice(1);
      foundAmount = true;
    } else {
      const lastToken = tokens[tokens.length - 1];
      const lastAmount = parseAmount(lastToken);
      if (lastAmount > 0 && /\d/.test(lastToken)) {
        amount = lastAmount;
        nameTokens = tokens.slice(0, -1);
        foundAmount = true;
      } else {
        for (let i = 0; i < tokens.length; i++) {
          const val = parseAmount(tokens[i]);
          if (val > 0 && /\d/.test(tokens[i])) {
            amount = val;
            nameTokens = tokens.filter((_, idx) => idx !== i);
            foundAmount = true;
            break;
          }
        }
      }
    }

    let name = nameTokens.join(' ').replace(/\//g, ' ').trim();
    if (foundAmount && amount > 0 && name) {
      entries.push({ amount, name, originalLine: rawLine });
    } else if (cleanLine) {
      entries.push({ amount: 0, name: cleanLine, originalLine: rawLine });
    }
  }

  return entries;
}

export default {
  formatRupiah,
  formatTime,
  getIndonesianDayName,
  getWeekNumber,
  cleanPhoneNumber,
  formatDateIndo,
  parseAmount,
  parseKasEntries
};
