import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { type BuiltChunk, initialJsBytes, preconnectTag } from './buildPlugins'

describe('preconnectTag', () => {
  it('opens the API origin early, for a CORS request', () => {
    expect(preconnectTag('https://cancelchain-api.onrender.com/')).toEqual({
      tag: 'link',
      attrs: { rel: 'preconnect', href: 'https://cancelchain-api.onrender.com', crossorigin: '' },
      injectTo: 'head',
    })
  })

  it.each([
    ['no API URL', undefined],
    ['the page origin', ''],
    ['something that is not a URL', 'cancelchain-api'],
  ])('adds nothing for %s', (_, value) => {
    expect(preconnectTag(value)).toBeNull()
  })
})

describe('initialJsBytes', () => {
  const chunk = (fileName: string, code: string, over: Partial<BuiltChunk> = {}): BuiltChunk => ({
    type: 'chunk',
    fileName,
    isEntry: false,
    imports: [],
    code,
    ...over,
  })
  const size = (code: string) => gzipSync(code).length

  it('counts the entry and what it imports statically, once each', () => {
    const shared = 'shared '.repeat(50)
    const result = initialJsBytes({
      'index.js': chunk('index.js', 'entry', {
        isEntry: true,
        imports: ['vendor.js', 'shared.js'],
      }),
      'vendor.js': chunk('vendor.js', 'vendor', { imports: ['shared.js'] }),
      'shared.js': chunk('shared.js', shared),
      'Subscription.js': chunk('Subscription.js', 'lazy '.repeat(500), { imports: ['shared.js'] }),
      'index.css': { type: 'asset' },
    })
    expect(result.files).toEqual(['index.js', 'shared.js', 'vendor.js'])
    expect(result.bytes).toBe(size('entry') + size('vendor') + size(shared))
  })

  it('is zero without an entry', () => {
    expect(initialJsBytes({ 'a.js': chunk('a.js', 'a') })).toEqual({ bytes: 0, files: [] })
  })
})
