import type { Logger } from './logger.js'

/**
 * The in-process indexer's watchdog (`T044`). `runIndexer` reconnects through
 * every failure it knows, so `done` settles on its own only on one it does not.
 * An API that kept answering without its indexer would look healthy to the
 * uptime monitor while the feed and the pushes quietly stopped; the host
 * restarts a process that exits, so the process exits.
 *
 * A stop the process asked for (`isStopping`) is not a failure.
 */
export function superviseIndexer(options: {
  done: Promise<void>
  isStopping: () => boolean
  logger: Pick<Logger, 'fatal'>
  onFatal: () => void
}): void {
  const { done, isStopping, logger, onFatal } = options
  done.then(
    () => {
      if (isStopping()) return
      logger.fatal('the in-process indexer stopped on its own')
      onFatal()
    },
    (error: unknown) => {
      if (isStopping()) return
      logger.fatal({ err: error }, 'the in-process indexer failed')
      onFatal()
    },
  )
}
