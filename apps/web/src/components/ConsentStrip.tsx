interface ConsentStripProps {
  used: number
  ceiling: number
  /** Height in pixels. 4 on cards, larger on the detail screen. */
  height?: number
}

/**
 * The only chart in the product: a full-width rail with the used portion of
 * this period's ceiling filled in ink.
 */
const ConsentStrip = ({ used, ceiling, height = 4 }: ConsentStripProps) => {
  const ratio = ceiling > 0 ? Math.min(Math.max(used / ceiling, 0), 1) : 0

  return (
    <div
      className="w-full bg-rail"
      style={{ height }}
      role="img"
      aria-label={`${Math.round(ratio * 100)} per cent of this period's ceiling used`}
    >
      <div
        className="h-full bg-ink transition-[width] duration-300 ease-out"
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  )
}

export default ConsentStrip
