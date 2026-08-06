import { createHmac } from 'node:crypto';

export function hmacSha256Hex(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}
