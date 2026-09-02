import { describe, expect, it } from 'vitest'
import {
  apiError,
  apiErrorSchema,
  ERROR_CODES,
  HTTP_STATUS_BY_ERROR_CODE,
  httpStatusFor,
} from './errors.js'

describe('apiError', () => {
  it('builds a body that matches the contract', () => {
    const body = apiError('NOT_FOUND', 'no such allowance')
    expect(apiErrorSchema.parse(body)).toEqual(body)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('omits the details key entirely when there are none', () => {
    const body = apiError('INTERNAL', 'boom')
    expect('details' in body.error).toBe(false)
    expect(JSON.stringify(body)).toBe('{"error":{"code":"INTERNAL","message":"boom"}}')
  })

  it('carries details when given', () => {
    const body = apiError('INVALID_INPUT', 'bad owner', { field: 'owner' })
    expect(apiErrorSchema.parse(body)).toEqual(body)
    expect(body.error.details).toEqual({ field: 'owner' })
  })

  it('rejects an empty message and an unknown code', () => {
    expect(apiErrorSchema.safeParse({ error: { code: 'INTERNAL', message: '' } }).success).toBe(
      false,
    )
    expect(apiErrorSchema.safeParse({ error: { code: 'TEAPOT', message: 'x' } }).success).toBe(
      false,
    )
  })
})

describe('http status map', () => {
  it('covers every error code exactly once', () => {
    expect(Object.keys(HTTP_STATUS_BY_ERROR_CODE).sort()).toEqual([...ERROR_CODES].sort())
  })

  it('maps each code to the status the contract promises', () => {
    expect(httpStatusFor('INVALID_INPUT')).toBe(400)
    expect(httpStatusFor('UNAUTHORIZED')).toBe(401)
    expect(httpStatusFor('NOT_FOUND')).toBe(404)
    expect(httpStatusFor('RATE_LIMITED')).toBe(429)
    expect(httpStatusFor('INTERNAL')).toBe(500)
  })
})
