import { useState } from 'react'
import { WalletMenu } from './chain/WalletMenu'
import { PERMISSIONS, type Permission, SUBSCRIBE_GRANT } from './lib/mockData'
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

const App = () => {
  const [view, setView] = useState<View>('subscriptions')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<Permission[]>(PERMISSIONS)
  const [planAllowed, setPlanAllowed] = useState(false)

  const update = (id: string, change: (permission: Permission) => Permission) =>
    setPermissions((current) => current.map((p) => (p.id === id ? change(p) : p)))

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
    setPermissions((current) =>
      current.some((p) => p.id === SUBSCRIBE_GRANT.id) ? current : [SUBSCRIBE_GRANT, ...current],
    )
  }

  const selected = permissions.find((p) => p.id === selectedId)

  return (
    <div className="min-h-screen bg-ground text-ink">
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <button type="button" onClick={() => setView('subscriptions')} className="text-left">
            <span className="block text-[14px] font-medium tracking-tight">CancelChain</span>
            <span className="mt-1 block text-[11px] text-ink/45">
              Demo — four screens, invented data, nothing on a network.
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
        {view === 'subscriptions' && (
          <Subscriptions
            permissions={permissions}
            onOpen={(id) => {
              setSelectedId(id)
              setView('detail')
            }}
            onCancel={cancel}
            onResume={resume}
            onKeep={keep}
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
              permissions={permissions}
              onOpen={(id) => {
                setSelectedId(id)
                setView('detail')
              }}
              onCancel={cancel}
              onResume={resume}
              onKeep={keep}
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
