import './index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'

import App from './App'
import { WalletProvider } from './chain/WalletProvider'

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
