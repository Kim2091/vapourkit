import * as crypto from 'crypto';

/**
 * sha256 of a .vkfilter's whole text, line endings normalized. The whole file
 * rather than its code: a user who only changed a default or a description
 * still made an edit, and it is theirs to keep. Line endings are normalized
 * because git hands the generator LF while a Windows checkout ships CRLF.
 */
export function shippedTemplateDigest(content: string | Buffer): string {
  const text = (typeof content === 'string' ? content : content.toString('utf8')).replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}
