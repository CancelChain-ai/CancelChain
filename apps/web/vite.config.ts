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

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': { target: API_TARGET, changeOrigin: true } },
  },
  test: { setupFiles: ['./vitest.setup.ts'] },
})
