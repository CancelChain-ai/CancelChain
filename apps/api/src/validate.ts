import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import { type ZodType, z } from 'zod'
import { fail } from './errors.js'

/**
 * `@hono/zod-validator` із **нашим** форматом помилки. Прямий `zValidator` без
 * хука відповідає власним тілом (`{ success: false, error: … }`), і клієнт, який
 * розбирає відповідь через `apiErrorSchema` зі `shared`, спіткнувся б саме на
 * невалідному запиті — тобто там, де діагностика потрібна найбільше.
 *
 * Тому в маршрутах викликається `validate(...)`, а не `zValidator(...)`, і схема
 * береться з `packages/shared`: тими самими схемами браузер розбирає відповідь.
 */
export function validate<T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return zValidator(target, schema, (result, c) => {
    if (result.success) return
    // `flattenError` дає `{ formErrors, fieldErrors }` — рівно те, що `details`
    // в `apiErrorSchema` описує як `Record<string, unknown>`.
    const flat = z.flattenError(result.error)
    return fail(c, 'INVALID_INPUT', 'invalid request', {
      formErrors: flat.formErrors,
      fieldErrors: flat.fieldErrors,
    })
  })
}
