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
  // Jika LID WhatsApp multi-device, jangan ubah formatnya
  if (String(phone).includes('@lid')) {
    return String(phone).split('@')[0].split(':')[0];
  }
  // Buang suffix device WhatsApp Web/Multi-device (:1, :2) dan domain (@s.whatsapp.net)
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
  let body = rawText.replace(/^!bot\s+kas\s+(?:masuk|koreksi|edit|ubah)\s*/i, '').trim();
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
    if ((firstAmount > 0 && /\d/.test(tokens[0])) || /^0+(k|rb)?$/i.test(tokens[0])) {
      amount = firstAmount;
      nameTokens = tokens.slice(1);
      foundAmount = true;
    } else {
      const lastToken = tokens[tokens.length - 1];
      const lastAmount = parseAmount(lastToken);
      if ((lastAmount > 0 && /\d/.test(lastToken)) || /^0+(k|rb)?$/i.test(lastToken)) {
        amount = lastAmount;
        nameTokens = tokens.slice(0, -1);
        foundAmount = true;
      } else {
        for (let i = 0; i < tokens.length; i++) {
          const val = parseAmount(tokens[i]);
          if ((val > 0 && /\d/.test(tokens[i])) || /^0+(k|rb)?$/i.test(tokens[i])) {
            amount = val;
            nameTokens = tokens.filter((_, idx) => idx !== i);
            foundAmount = true;
            break;
          }
        }
      }
    }

    let name = nameTokens.join(' ').replace(/\//g, ' ').trim();
    if (foundAmount && amount >= 0 && name) {
      entries.push({ amount, name, originalLine: rawLine });
    } else if (cleanLine) {
      entries.push({ amount: 0, name: cleanLine, originalLine: rawLine });
    }
  }

  return entries;
}

export function parseMonthInput(input) {
  if (!input) {
    return new Date().getMonth() + 1; // Default bulan berjalan (1-12)
  }
  let clean = String(input).trim().toLowerCase();
  clean = clean.replace(/^(?:bulan|bln)\s*/i, '').trim();

  const num = parseInt(clean, 10);
  if (!isNaN(num) && num >= 1 && num <= 12) {
    return num;
  }

  const map = {
    'januari': 1, 'jan': 1, 'january': 1,
    'februari': 2, 'feb': 2, 'february': 2,
    'maret': 3, 'mar': 3, 'march': 3,
    'april': 4, 'apr': 4,
    'mei': 5, 'may': 5,
    'juni': 6, 'jun': 6, 'june': 6,
    'juli': 7, 'jul': 7, 'july': 7,
    'agustus': 8, 'agt': 8, 'agu': 8, 'august': 8, 'aug': 8,
    'september': 9, 'sep': 9, 'sept': 9,
    'oktober': 10, 'okt': 10, 'october': 10, 'oct': 10,
    'november': 11, 'nov': 11,
    'desember': 12, 'des': 12, 'december': 12, 'dec': 12,
    'pertama': 1, 'satu': 1, 'kesatu': 1,
    'kedua': 2, 'dua': 2,
    'ketiga': 3, 'tiga': 3,
    'keempat': 4, 'empat': 4,
    'kelima': 5, 'lima': 5,
    'keenam': 6, 'enam': 6,
    'ketujuh': 7, 'tujuh': 7,
    'kedelapan': 8, 'delapan': 8,
    'kesembilan': 9, 'sembilan': 9,
    'kesepuluh': 10, 'sepuluh': 10,
    'kesebelas': 11, 'sebelas': 11,
    'keduabelas': 12, 'dua belas': 12
  };

  if (map[clean]) {
    return map[clean];
  }

  const matchBulan = clean.match(/(?:ke[- ]?)?(\d{1,2})/);
  if (matchBulan) {
    const val = parseInt(matchBulan[1], 10);
    if (val >= 1 && val <= 12) return val;
  }

  return new Date().getMonth() + 1;
}

export default {
  formatRupiah,
  formatTime,
  getIndonesianDayName,
  getWeekNumber,
  cleanPhoneNumber,
  formatDateIndo,
  parseAmount,
  parseKasEntries,
  parseMonthInput
};
