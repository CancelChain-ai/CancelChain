import { resolve } from 'node:path'
import { resolveConfig } from 'vite'
import { describe, expect, it } from 'vitest'

/**
 * Межа між файлом оточення і публічним бандлом.
 *
 * `envDir` показує на корінь монорепо, а там у `.env` лежать `JWT_SECRET` і
 * `DATABASE_URL`. Єдине, що не пускає їх у зібрану сторінку, — `envPrefix`.
 * Тому він перевіряється тут, а не лишається замовчуванням чужої бібліотеки:
 * зміна замовчування в Vite або випадкове розширення префікса опублікували б
 * секрети мовчки, і помітити це можна було б лише в уже викладеному бандлі.
 */

const WEB_ROOT = resolve(import.meta.dirname)
const REPO_ROOT = resolve(WEB_ROOT, '../..')

describe('оточення збірки', () => {
  it('файли оточення беруться з кореня монорепо, а не з теки застосунку', async () => {
    const config = await resolveConfig({ root: WEB_ROOT }, 'build')
    expect(resolve(config.envDir)).toBe(REPO_ROOT)
  })

  it('у бандл виходить лише префікс VITE_', async () => {
    const config = await resolveConfig({ root: WEB_ROOT }, 'build')
    expect(config.envPrefix).toEqual(['VITE_'])
  })

  /*
   * Той самий файл читає API, і його змінні названі тут поіменно: якщо
   * колись з'явиться префікс на кшталт `''` або `'DATABASE'`, цей тест
   * назве, що саме поїде в браузер.
   */
  it('жодна змінна сервера під цей префікс не підпадає', async () => {
    const config = await resolveConfig({ root: WEB_ROOT }, 'build')
    const prefixes = config.envPrefix as string[]
    for (const secret of ['JWT_SECRET', 'DATABASE_URL', 'AUTH_DOMAIN', 'SOLANA_RPC_URL']) {
      expect(prefixes.some((prefix) => prefix !== '' && secret.startsWith(prefix))).toBe(false)
    }
  })
})
