import PermissionCard from '../components/PermissionCard'
import { allowedTotal, formatAmount, type Permission, WALLET } from '../lib/mockData'

interface SubscriptionsProps {
  permissions: Permission[]
  onOpen: (id: string) => void
  onCancel: (id: string) => void
  onResume: (id: string) => void
  onKeep: (id: string) => void
}

const Subscriptions = ({ permissions, onOpen, onCancel, onResume, onKeep }: SubscriptionsProps) => {
  const total = allowedTotal(permissions)

  const ordered = permissions
    .map((permission, index) => ({ permission, index }))
    .sort((a, b) => {
      const aCancelled = a.permission.state === 'cancelled' ? 1 : 0
      const bCancelled = b.permission.state === 'cancelled' ? 1 : 0
      if (aCancelled !== bCancelled) return aCancelled - bCancelled
      return a.index - b.index
    })
    .map((entry) => entry.permission)

  const everythingCancelled = permissions.every((p) => p.state === 'cancelled')

  return (
    <div>
      <div className="flex flex-col gap-6 border-b border-hairline pb-10 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[13px] text-ink/55">You have allowed</p>
          <p className="mt-2 text-[48px] font-medium leading-none tracking-tight tnum sm:text-[56px]">
            {formatAmount(total.amount, 'USDC')}
          </p>
          <p className="mt-3 text-[13px] text-ink/55 tnum">
            per month, across {total.count} active{' '}
            {total.count === 1 ? 'permission' : 'permissions'}
          </p>
          <p className="mt-1 text-[12px] text-ink/45">
            Paused and unsupported permissions are not counted.
          </p>
        </div>
        <p className="text-[13px] text-ink/55 tnum sm:pt-1">Wallet {WALLET}</p>
      </div>

      {everythingCancelled ? (
        <p className="mt-12 max-w-[520px] text-[15px] leading-relaxed text-ink/70">
          No one can charge this wallet. Nothing here means nothing is running — not that we failed
          to load anything.
        </p>
      ) : (
        <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-2">
          {ordered.map((permission) => (
            <PermissionCard
              key={permission.id}
              permission={permission}
              onOpen={onOpen}
              onCancel={onCancel}
              onResume={onResume}
              onKeep={onKeep}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default Subscriptions
