# ==========================================
# Dockerfile: Bot WhatsApp Bendahara & Web Dashboard
# Image Ringan berbasis Node.js 20 Alpine
# ==========================================

FROM node:20-alpine

# Set Timezone Asia/Jakarta untuk ketepatan waktu cron pengingat kelas
RUN apk add --no-cache tzdata
ENV TZ=Asia/Jakarta

WORKDIR /app

# Salin manifest dependensi terlebih dahulu untuk optimasi Docker layer caching
COPY package*.json ./

# Install dependensi produksi saja
RUN npm install --omit=dev

# Salin seluruh kode aplikasi
COPY . .

# Buat folder auth_info untuk penyimpanan sesi Baileys
RUN mkdir -p /app/auth_info

# Expose Port Web Dashboard
EXPOSE 3000

# Jalankan server
CMD ["node", "index.js"]
