# ==============================================================================
# Absensi Perusahaan, server Web (Next.js) untuk pemasangan self-hosted.
#
# Hasilnya image yang berisi build `standalone` saja: tanpa `src/`, tanpa
# `node_modules` lengkap, tanpa source map. Itulah yang diserahkan ke pembeli,
# bukan repo ini.
#
# Menerbitkan (dijalankan pemilik aplikasi, dari root repo):
#   bun run image:build --versi <versi>
# Perintah itu membangun image ini dan menyusun folder `rilis/` yang siap
# diserahkan. Untuk jalur registry, beri tag lalu dorong:
#   docker tag <nama-image>:<versi> <registry>/<nama-image>:<versi>
#   docker push <registry>/<nama-image>:<versi>
# Pembeli memakainya lewat `deploy/docker-compose.yml`.
# ==============================================================================

# Tahap 1: dependensi
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Tahap 2: build
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# `build:web` menyetel target build-nya sendiri; yang ditambahkan di sini hanya
# permintaan keluaran standalone (lihat `next.config.ts`).
ENV KOS_BUILD_STANDALONE=1
# Image pembeli SELALU menegakkan lisensi. Nilainya ditanam ke hasil build
# (lihat `next.config.ts`), jadi tidak bisa dimatikan lewat `.env` di server.
ENV KOS_LICENSE_ENFORCED=1

RUN bun run build:web

# Next.js menyalin setiap `.env*` yang ia temukan ke `.next/standalone/`.
# `.dockerignore` sudah menahannya di luar konteks build; langkah ini penjaga
# kedua, dan ia MEMERIKSA hasilnya. Menghapus tanpa memeriksa hanya memindahkan
# kepercayaan: bila suatu saat ada berkas rahasia atau source yang lolos, build
# harus gagal di sini, bukan sampai ke tangan pembeli.
RUN rm -f .next/standalone/.env* \
  && find .next/standalone -name "*.map" -not -path "*/node_modules/*" -delete \
  && bocor="$(find .next/standalone -not -path '*/node_modules/*' \
       \( -name '.env*' -o -name '*.ts' -o -name '*.tsx' -o -name '*.rs' -o -name '*.map' \) -print)" \
  && if [ -n "$bocor" ]; then echo "Berkas yang tidak boleh ikut image:"; echo "$bocor"; exit 1; fi

# Tahap 3: runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 3000

CMD ["node", "server.js"]
