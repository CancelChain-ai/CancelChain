/**
 * Node 22 має власний глобальний `localStorage`, доступний лише з прапорцем
 * `--localstorage-file`; він перекриває той, що дає jsdom, і в тестах
 * `window.localStorage` виявляється `undefined` (при цьому `sessionStorage`
 * працює — звідси й видно, що це не jsdom).
 *
 * Підставляємо реалізацію в пам'яті **до** імпорту модулів застосунку: інакше
 * `browserStorage()` встиг би зафіксувати відсутність сховища. У браузері цей
 * файл не виконується взагалі.
 */

function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  }
}

if (typeof window !== 'undefined' && window.localStorage === undefined) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: memoryStorage(),
  })
}
