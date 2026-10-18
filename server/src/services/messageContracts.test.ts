import assert from 'node:assert/strict';
import test from 'node:test';
import { directMessageInputSchema, threadMessageInputSchema, workReviewSubmissionSchema } from './messageContracts';

const submissionId = '7e3c6054-6ab6-41b4-a25f-8f3f761f49e4';

test('thread and private messages accept the 20,000-character boundary', () => {
  const message = 'x'.repeat(20000);
  assert.equal(threadMessageInputSchema.safeParse({ message }).success, true);
  assert.equal(directMessageInputSchema.safeParse({ message }).success, true);
});

test('thread and private messages reject over-limit and over-word-limit input', () => {
  assert.equal(threadMessageInputSchema.safeParse({ message: 'x'.repeat(20001) }).success, false);
  assert.equal(directMessageInputSchema.safeParse({ message: Array(2001).fill('word').join(' ') }).success, false);
});

test('message input requires text or an attachment', () => {
  assert.equal(threadMessageInputSchema.safeParse({ message: '   ' }).success, false);
  assert.equal(directMessageInputSchema.safeParse({ message: '', attachment: { kind: 'file', name: 'brief.pdf', mimeType: 'application/pdf', size: 4, dataUrl: `data:application/pdf;base64,${'A'.repeat(32)}` } }).success, true);
});

test('delivery handoff requires a note, enforces its maximum, and requires an idempotency key', () => {
  assert.equal(workReviewSubmissionSchema.safeParse({ message: 'short note', submissionId }).success, true);
  assert.equal(workReviewSubmissionSchema.safeParse({ message: 'short', submissionId }).success, false);
  assert.equal(workReviewSubmissionSchema.safeParse({ message: 'x'.repeat(2001), submissionId }).success, false);
  assert.equal(workReviewSubmissionSchema.safeParse({ message: 'A sufficiently long delivery note.' }).success, false);
});
