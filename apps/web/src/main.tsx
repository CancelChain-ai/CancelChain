import './index.css'
import { createRoot } from 'react-dom/client'

import App from './App'
import { WalletProvider } from './chain/WalletProvider'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Failed to find the root element')

createRoot(rootElement).render(
  <WalletProvider>
    <App />
  </WalletProvider>,
)
