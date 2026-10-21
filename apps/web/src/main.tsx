import './index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'

import App from './App'
import { WalletProvider } from './chain/WalletProvider'
import { reloadOnStaleBuild } from './lib/staleBuild'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Failed to find the root element')

/**
 * Кеш серверного стану. `refetchOnWindowFocus` лишається увімкненим навмисно:
 * повернення на вкладку — найчастіший момент, коли показане на екрані вже
 * не є станом мережі, а `FR-025` віддає пріоритет мережі, не показаному.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, gcTime: 5 * 60_000 } },
})

createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <WalletProvider>
      <App />
    </WalletProvider>
  </QueryClientProvider>,
)

/**
 * The worker (`public/sw.js`) keeps the app's own files for the next visit
 * (`SC-008`). Registered after `load`, so it never competes with this visit for
 * the network, and only in a build: in development it would serve stale modules.
 */
reloadOnStaleBuild(import.meta.url)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const scope = import.meta.env.BASE_URL
    // No worker is a slower next visit, not a broken one.
    navigator.serviceWorker.register(`${scope}sw.js`, { scope }).catch(() => {})
  })
}
