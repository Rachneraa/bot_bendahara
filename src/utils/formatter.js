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

export default {
  formatRupiah,
  formatTime,
  getIndonesianDayName,
  getWeekNumber,
  cleanPhoneNumber,
  formatDateIndo
};
