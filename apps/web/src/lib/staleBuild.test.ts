import { describe, expect, it } from 'vitest'
import { RELOADED_FOR_KEY, reloadIsDue } from './staleBuild'

function memory(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  }
}

const A = 'https://cancelchain-ai.github.io/CancelChain/assets/index-A.js'
const B = 'https://cancelchain-ai.github.io/CancelChain/assets/index-B.js'

describe('reloadIsDue', () => {
  it('reloads a version once, and not again when the reload drew it once more', () => {
    const storage = memory()
    expect(reloadIsDue(storage, A)).toBe(true)
    expect(storage.getItem(RELOADED_FOR_KEY)).toBe(A)
    expect(reloadIsDue(storage, A)).toBe(false)
  })

  it('reloads again for another version, however soon after', () => {
    const storage = memory()
    reloadIsDue(storage, A)
    expect(reloadIsDue(storage, B)).toBe(true)
  })

  it('does not reload without a storage that can tell the second time from the first', () => {
    expect(reloadIsDue(null, A)).toBe(false)
    const throwing = {
      ...memory(),
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
    }
    expect(reloadIsDue(throwing, A)).toBe(false)
  })
})
