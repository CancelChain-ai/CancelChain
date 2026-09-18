import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * `VITE_API_URL` не задано — клієнт стукає у власний origin (`lib/source.ts`),
 * а `/v1` у розробці проксює сюди. Так зібраний застосунок ніколи не має в собі
 * зашитого `localhost`, а локальний запуск не потребує жодної змінної оточення.
 *
 * `API_PROXY_TARGET` — без префікса `VITE_` навмисно: він переносить сюди лише
 * адресу проксі, і в бандл не потрапляє. `VITE_API_URL` натомість **потрапляє**,
 * тож задавати його заради локального порту означало б змусити браузер піти на
 * інший origin і впертися в CORS.
 */
const API_TARGET =
  process.env.API_PROXY_TARGET ?? process.env.VITE_API_URL ?? 'http://localhost:8080'

/**
 * Шлях, під яким сторінка лежить на хості. `/` — власний домен або корінь;
 * `/CancelChain/` — GitHub Pages проєкту (`.github/workflows/pages.yml`).
 * Без префікса `VITE_`: це параметр збірки, а не рантайму, і в бандл він
 * потрапляє лише як уже підставлені шляхи до `assets/`.
 */
const BASE_PATH = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base: BASE_PATH,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': { target: API_TARGET, changeOrigin: true } },
  },
  test: { setupFiles: ['./vitest.setup.ts'] },
})
