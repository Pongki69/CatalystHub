import assert from 'node:assert/strict';
import test from 'node:test';
import { errorHandler } from './errors';

function response() {
  const result: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { result.status = code; return this; },
    json(body: unknown) { result.body = body; return this; },
  };
  return { result, res };
}

test('body parser size errors retain a safe 413 response', () => {
  const { result, res } = response();
  errorHandler(Object.assign(new Error('private parser details'), { status: 413 }), {} as never, res as never, (() => undefined) as never);
  assert.equal(result.status, 413);
  assert.deepEqual(result.body, { success: false, message: 'The request body is too large.' });
});

test('unknown server errors remain generic', () => {
  const { result, res } = response();
  const original = console.error;
  console.error = () => undefined;
  try { errorHandler(new Error('secret detail'), {} as never, res as never, (() => undefined) as never); }
  finally { console.error = original; }
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { success: false, message: 'An unexpected server error occurred.' });
});
