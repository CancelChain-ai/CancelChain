import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Пін трійки версій — `FR-021` і жорстке правило проєкту.
 *
 * `@solana/subscriptions@0.5.0` має peer `@solana/kit ^7.0.0`. Підйом kit до 8
 * не ламає ані збірку, ані типи одразу: peer лишається невдоволеним, а падає
 * все далеко нижче за течією. Тому пін перевіряється **по фактично встановлених
 * файлах**, а не по тому, що написано в `package.json` як намір.
 */

const PINNED = {
  '@solana/kit': '7.1.1',
  '@solana/react': '7.1.1',
  '@solana/subscriptions': '0.5.0',
} as const

/** Установлені в `packages/chain`. `@solana/react` живе у `web` — див. `T017`. */
const INSTALLED_HERE = ['@solana/kit', '@solana/subscriptions'] as const

function readJson(url: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(url, 'utf8'))
}

const workspaceYaml = readFileSync(new URL('../../../pnpm-workspace.yaml', import.meta.url), 'utf8')

describe('каталог pnpm', () => {
  for (const [name, version] of Object.entries(PINNED)) {
    it(`пиняє ${name} на ${version} без діапазону`, () => {
      expect(workspaceYaml).toContain(`"${name}": ${version}`)
    })
  }

  it('не містить діапазонів у секції catalog', () => {
    const catalog = workspaceYaml.slice(workspaceYaml.indexOf('catalog:'))
    expect(catalog).not.toMatch(/:\s*[\^~]/)
  })
})

describe('фактично встановлені версії', () => {
  for (const name of INSTALLED_HERE) {
    it(`${name} — рівно ${PINNED[name]}`, () => {
      const pkg = readJson(new URL(`../node_modules/${name}/package.json`, import.meta.url))
      expect(pkg.version).toBe(PINNED[name])
    })
  }

  it('пакет посилається на каталог, а не на власний рядок версії', () => {
    const pkg = readJson(new URL('../package.json', import.meta.url))
    const deps = pkg.dependencies as Record<string, string>
    for (const name of INSTALLED_HERE) {
      expect(deps[name]).toBe('catalog:')
    }
  })
})

/**
 * `@solana/react` живе в `apps/web` (`T017`), тож перевіряти його встановлену
 * версію треба саме там. Другий kit, який приїхав би разом із ним, зробив би
 * дві копії branded-типів адреси — і мовчазний розкол на межі браузер/пакет.
 */
describe('@solana/react у apps/web', () => {
  const webRoot = new URL('../../../apps/web/', import.meta.url)

  it(`встановлений рівно ${PINNED['@solana/react']}`, () => {
    const pkg = readJson(new URL('node_modules/@solana/react/package.json', webRoot))
    expect(pkg.version).toBe(PINNED['@solana/react'])
  })

  it('web бере обидва пакети з каталогу, а не власним рядком версії', () => {
    const pkg = readJson(new URL('package.json', webRoot))
    const deps = pkg.dependencies as Record<string, string>
    expect(deps['@solana/react']).toBe('catalog:')
    expect(deps['@solana/kit']).toBe('catalog:')
  })

  it('kit у web — той самий 7.1.1, що й у packages/chain', () => {
    const kit = readJson(new URL('node_modules/@solana/kit/package.json', webRoot))
    expect(kit.version).toBe(PINNED['@solana/kit'])
  })

  it('peer-вимога @solana/react лишається на kit ^7', () => {
    const pkg = readJson(new URL('node_modules/@solana/react/package.json', webRoot))
    const peers = pkg.peerDependencies as Record<string, string>
    expect(peers['@solana/kit']).toBe('^7.1.1')
  })
})

describe('peer-вимога SDK програми', () => {
  it('лишається ^7 — саме вона робить kit 8 недопустимим', () => {
    const sdk = readJson(
      new URL('../node_modules/@solana/subscriptions/package.json', import.meta.url),
    )
    const peers = sdk.peerDependencies as Record<string, string>
    expect(peers['@solana/kit']).toBe('^7.0.0')
  })

  it('встановлений kit потрапляє в цей діапазон', () => {
    const kit = readJson(new URL('../node_modules/@solana/kit/package.json', import.meta.url))
    expect(String(kit.version).startsWith('7.')).toBe(true)
  })
})
