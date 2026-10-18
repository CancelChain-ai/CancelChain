import type { DemoSnapshot } from '@cancelchain/shared/snapshot'
import { shortenAddress } from '../chain/wallet'
import { copyMoment } from '../pages/Subscriptions'

const BUTTON =
  'rounded-md border px-3 py-1.5 text-[12px] transition-colors duration-150 hover:text-ink'

const StepLink = ({ signature, url }: { signature: string; url: string | null }) =>
  url === null ? (
    <span className="font-mono">{shortenAddress(signature)}</span>
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:text-ink"
    >
      {shortenAddress(signature)}
    </a>
  )

/**
 * The replay's own strip (`T058`), on every screen: the screens below show a
 * recording, and nothing about them may pass for live. It also carries what the
 * screens cannot — the merchant's refused charge on a cancelled permission is a
 * transaction, and its proof is the link to it, not a card.
 */
export const ReplayBar = ({
  snapshot,
  stageId,
  onStage,
  explorerUrl,
}: {
  snapshot: DemoSnapshot
  stageId: string
  onStage: (id: string) => void
  explorerUrl: (signature: string) => string | null
}) => {
  const index = Math.max(
    0,
    snapshot.stages.findIndex((stage) => stage.id === stageId),
  )
  const stage = snapshot.stages[index]
  const shown = new Set(snapshot.stages.slice(0, index + 1).map((candidate) => candidate.id))
  const steps = snapshot.steps.filter((step) => shown.has(step.stage))

  return (
    <section
      aria-label="Recording"
      className="mb-10 rounded-[10px] border border-dashed border-amber/60 px-4 py-4 text-[12px] leading-relaxed"
    >
      <p className="text-amber">
        A recording of {snapshot.cluster}, made {copyMoment(new Date(snapshot.recordedAt))} — not
        live. Wallet {shortenAddress(snapshot.owner)} was made for the recording; the merchant is
        merchant-sim, a {snapshot.cluster} stand-in, not a real company.
      </p>

      <fieldset className="mt-3 flex flex-wrap gap-2">
        <legend className="sr-only">Stage</legend>
        {snapshot.stages.map((candidate, position) => {
          const active = candidate.id === stage?.id
          return (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={active}
              onClick={() => onStage(candidate.id)}
              className={`${BUTTON} ${active ? 'border-ink/40 text-ink' : 'border-hairline text-ink/55'}`}
            >
              {position + 1}. {candidate.title}
            </button>
          )
        })}
      </fieldset>

      {stage !== undefined && <p className="mt-3 text-ink/70">{stage.summary}</p>}

      <ol className="mt-3 space-y-1 text-ink/55">
        {steps.map((step) => (
          <li key={step.signature} className="tnum">
            <span className={step.outcome === 'refused' ? 'text-rust' : 'text-ink/70'}>
              {step.outcome === 'refused' ? 'Refused' : 'Confirmed'}
            </span>{' '}
            · {step.label}
            {step.refusal !== null && ` — ${step.refusal}`} ·{' '}
            <StepLink signature={step.signature} url={explorerUrl(step.signature)} />
          </li>
        ))}
      </ol>
    </section>
  )
}
