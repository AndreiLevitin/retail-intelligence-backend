import { createHash, timingSafeEqual } from 'node:crypto'
import { HttpError } from './responses.js'

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Shared operator token check ("Authorization: Bearer <token>"). This is a
 * limited demo access mechanism, not user authentication. The token is only
 * accepted from the header and never echoed, stored or logged.
 */
export function requireOperator(request: Request, operatorToken: string): void {
  const header = request.headers.get('authorization')
  const match = header === null ? null : /^Bearer[ ]+(\S+)[ ]*$/i.exec(header)
  const presented = match?.[1]
  if (!presented || !timingSafeEqual(digest(presented), digest(operatorToken))) {
    throw new HttpError('UNAUTHORIZED', 'A valid operator token is required.', {
      'www-authenticate': 'Bearer',
    })
  }
}
