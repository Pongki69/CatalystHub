import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAttachment } from './attachmentValidation';
import { DirectMessage } from '../models/DirectMessage';
import { ThreadMessage } from '../models/ThreadMessage';

function attachment(kind: 'image' | 'audio' | 'file', name: string, mimeType: string, payload: Buffer) {
  return { kind, name, mimeType, size: payload.length, dataUrl: `data:${mimeType};base64,${payload.toString('base64')}` } as const;
}

test('valid image payload is accepted and MIME spoofing is rejected', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  assert.equal(validateAttachment(attachment('image', 'proof.png', 'image/png', png)), null);
  assert.match(validateAttachment(attachment('image', 'proof.png', 'image/png', Buffer.from('not a png')) ) || '', /contents do not match/);
});

test('attachment extension must match its declared MIME type', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  assert.match(validateAttachment(attachment('image', 'proof.jpg', 'image/png', png)) || '', /extension does not match/);
});

test('unsupported attachment MIME types are rejected', () => {
  const payload = Buffer.from('<html>not an attachment</html>');
  assert.match(validateAttachment(attachment('file', 'page.html', 'text/html', payload)) || '', /format is not supported/);
});

test('attachment caps reject oversized images, audio, and files', () => {
  assert.match(validateAttachment(attachment('image', 'large.png', 'image/png', Buffer.alloc(4 * 1024 * 1024 + 1))) || '', /Images must be 4 MB or smaller/);
  assert.match(validateAttachment(attachment('audio', 'large.mp3', 'audio/mpeg', Buffer.alloc(2 * 1024 * 1024 + 1))) || '', /Voice messages must be 2 MB or smaller/);
  assert.match(validateAttachment(attachment('file', 'large.txt', 'text/plain', Buffer.alloc(5 * 1024 * 1024 + 1))) || '', /Files must be 5 MB or smaller/);
});

test('direct-message schema stores supported document attachments', () => {
  const pdf = attachment('file', 'brief.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
  const message = new DirectMessage({ conversation: '507f1f77bcf86cd799439011', sender: '507f1f77bcf86cd799439012', message: '', attachment: pdf });
  assert.equal(message.validateSync(), undefined);
  const requestMessage = new ThreadMessage({ ticket: '507f1f77bcf86cd799439013', sender: '507f1f77bcf86cd799439012', message: '', attachment: pdf });
  assert.equal(requestMessage.validateSync(), undefined);
});

test('message persistence supports the route character limit', () => {
  const text = 'x'.repeat(20000);
  const message = new DirectMessage({ conversation: '507f1f77bcf86cd799439011', sender: '507f1f77bcf86cd799439012', message: text });
  assert.equal(message.validateSync(), undefined);
});
