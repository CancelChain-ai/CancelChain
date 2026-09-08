import { useState } from 'react'
import { WalletMenu } from './chain/WalletMenu'
import { useWalletEnvironment } from './chain/WalletProvider'
import { shortenAddress, useWalletOwner } from './chain/wallet'
import { type Permission, SUBSCRIBE_GRANT, WALLET } from './lib/mockData'
import { mockData, source } from './lib/source'
import { useAllowances } from './lib/useAllowances'
import Merchant from './pages/Merchant'
import Subscribe from './pages/Subscribe'
import Subscription from './pages/Subscription'
import Subscriptions from './pages/Subscriptions'

type View = 'subscriptions' | 'detail' | 'subscribe' | 'merchant'

const TABS: { id: View; label: string }[] = [
  { id: 'subscriptions', label: 'My subscriptions' },
  { id: 'subscribe', label: 'Subscribe to a plan' },
  { id: 'merchant', label: 'Merchant panel' },
]

/**
 * Екрани, які досі стоять на моці M0.
 *
 * Коли список уже читає devnet, ці три не читають нічого, і сказати про це
 * треба на самому екрані: підпис у шапці стосується застосунку в цілому, а
 * людина дивиться на конкретну сторінку. Перелік скорочується з кожною
 * задачею — `T024` знімає `detail`, `T036` — `subscribe`, `T052` — `merchant`.
 */
const MOCK_ONLY_VIEWS: View[] = ['detail', 'subscribe', 'merchant']

const App = () => {
  const { cluster } = useWalletEnvironment()
  const [view, setView] = useState<View>('subscriptions')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /**
   * Мок M0 змінюється кліками, і список читає його через те саме джерело, що й
   * справжні дані. Ревізія входить у ключ запиту, тож зміна видна і в списку, і
   * на екрані картки — інакше скасування було б видно лише на одному з них, і
   * прототип суперечив би сам собі.
   */
  const [mockRevision, setMockRevision] = useState(0)
  const [planAllowed, setPlanAllowed] = useState(false)

  const owner = useWalletOwner()
  const allowances = useAllowances(owner, mockRevision)

  const update = (id: string, change: (permission: Permission) => Permission) => {
    mockData.update(id, change)
    setMockRevision((revision) => revision + 1)
  }

  const cancel = (id: string) =>
    update(id, (p) => ({ ...p, state: 'cancelled', endsOn: undefined }))

  const keep = (id: string) => update(id, (p) => ({ ...p, state: 'active', endsOn: undefined }))

  const resume = (id: string) =>
    update(id, (p) => ({ ...p, state: 'active', nextCharge: p.nextChargeOnResume ?? null }))

  const pause = (id: string) =>
    update(id, (p) => ({
      ...p,
      state: 'paused',
      nextChargeOnResume: p.nextCharge ?? p.nextChargeOnResume,
      nextCharge: null,
    }))

  const dontRenew = (id: string) =>
    update(id, (p) =>
      p.nextCharge === null ? p : { ...p, state: 'ending', endsOn: p.nextCharge, nextCharge: null },
    )

  const allowPlan = () => {
    if (planAllowed) return
    setPlanAllowed(true)
    mockData.prepend(SUBSCRIBE_GRANT)
    setMockRevision((revision) => revision + 1)
  }

  /**
   * Екран картки живе на моці до `T024`, тож відкривати його можна лише з
   * мок-списку: за PDA справжнього дозволу тут нема чого показати, і підсунути
   * туди вигадану картку означало б збрехати про справжні гроші.
   */
  const openDetail =
    source.kind === 'mock'
      ? (id: string) => {
          setSelectedId(id)
          setView('detail')
        }
      : undefined

  const selected = selectedId === null ? undefined : mockData.find(selectedId)
  const walletLabel = source.requiresWallet
    ? owner === null
      ? null
      : shortenAddress(owner)
    : WALLET

  return (
    <div className="min-h-screen bg-ground text-ink">
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <button type="button" onClick={() => setView('subscriptions')} className="text-left">
            <span className="block text-[14px] font-medium tracking-tight">CancelChain</span>
            <span className="mt-1 block text-[11px] text-ink/45">
              {source.onNetwork
                ? `Live ${cluster} — every permission granted from the connected wallet.`
                : 'Demo — four screens, invented data, nothing on a network.'}
            </span>
          </button>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <nav className="flex flex-wrap gap-x-5 gap-y-1">
              {TABS.map((tab) => {
                const active = view === tab.id || (view === 'detail' && tab.id === 'subscriptions')
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setView(tab.id)}
                    className={`text-[13px] transition-colors duration-150 ${
                      active
                        ? 'text-ink underline underline-offset-[6px]'
                        : 'text-ink/45 hover:text-ink/70'
                    }`}
                  >
                    {tab.label}
                  </button>
                )
              })}
            </nav>
            <WalletMenu />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1080px] px-5 py-10 sm:px-8 sm:py-14">
        {source.onNetwork && MOCK_ONLY_VIEWS.includes(view) && (
          <p className="mb-8 rounded-[10px] border border-dashed border-hairline px-4 py-3 text-[12px] text-ink/55">
            This screen is still the M0 prototype: invented merchants, invented numbers, nothing
            read from {cluster}. Only the list of permissions is live.
          </p>
        )}

        {view === 'subscriptions' && (
          <Subscriptions
            state={allowances}
            walletLabel={walletLabel}
            onNetwork={source.onNetwork}
            onOpen={openDetail}
          />
        )}

        {view === 'detail' &&
          (selected ? (
            <Subscription
              permission={selected}
              onBack={() => setView('subscriptions')}
              onPause={pause}
              onDontRenew={dontRenew}
              onResume={resume}
              onKeep={keep}
              onCancelNow={(id) => {
                cancel(id)
                setView('subscriptions')
              }}
            />
          ) : (
            <Subscriptions
              state={allowances}
              walletLabel={walletLabel}
              onNetwork={source.onNetwork}
              onOpen={openDetail}
            />
          ))}

        {view === 'subscribe' && (
          <Subscribe
            onDone={() => setView('subscriptions')}
            onAllow={allowPlan}
            alreadyGiven={planAllowed}
          />
        )}

        {view === 'merchant' && <Merchant />}
      </main>
    </div>
  )
}

export default App
