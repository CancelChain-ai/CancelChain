import type { Address } from '@cancelchain/shared'
import { SubscribeFlow } from './chain/subscribe'
import { useSubscribeReview } from './lib/useSubscribeReview'
import { LiveSubscribe } from './pages/Subscribe'

/**
 * The live subscribe screen with everything only it needs: the plan read and the
 * subscribe builder load with this module, not with the list (`SC-008`).
 */
const SubscribeView = ({
  planPda,
  owner,
  onOpenPlan,
  onDone,
  explorerUrl,
}: {
  planPda: string | null
  owner: Address | null
  onOpenPlan: (pda: string) => void
  onDone: () => void
  explorerUrl: (signature: string) => string | null
}) => {
  const review = useSubscribeReview(planPda, owner)
  return (
    // Keyed by plan: a finished or stopped flow belongs to the plan it ran for.
    <SubscribeFlow key={planPda ?? ''}>
      {(controls) => (
        <LiveSubscribe
          state={review}
          onOpenPlan={onOpenPlan}
          controls={controls}
          onDone={onDone}
          explorerUrl={explorerUrl}
        />
      )}
    </SubscribeFlow>
  )
}

export default SubscribeView
