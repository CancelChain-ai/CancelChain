import { describe, expect, it } from 'vitest'
import { superviseIndexer } from './supervise.js'

function watch(done: Promise<void>, stopping = false) {
  const fatal: unknown[] = []
  let exits = 0
  superviseIndexer({
    done,
    isStopping: () => stopping,
    logger: { fatal: ((...args: unknown[]) => fatal.push(args)) as never },
    onFatal: () => {
      exits += 1
    },
  })
  return { fatal, exits: () => exits }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('superviseIndexer (T044)', () => {
  it('takes the process down when the indexer stops on its own', async () => {
    const run = watch(Promise.resolve())
    await settle()
    expect(run.exits()).toBe(1)
    expect(run.fatal).toHaveLength(1)
  })

  it('takes the process down when the indexer fails', async () => {
    const run = watch(Promise.reject(new Error('socket gone')))
    await settle()
    expect(run.exits()).toBe(1)
  })

  it('leaves a stop the process asked for alone', async () => {
    const run = watch(Promise.resolve(), true)
    await settle()
    expect(run.exits()).toBe(0)
    expect(run.fatal).toEqual([])
  })
})
