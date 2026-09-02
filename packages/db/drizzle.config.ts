import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
  dbCredentials: {
    // Потрібен лише для `migrate`/`push`. `generate` читає саму схему й до бази не ходить.
    url: process.env.DATABASE_URL ?? '',
  },
})
