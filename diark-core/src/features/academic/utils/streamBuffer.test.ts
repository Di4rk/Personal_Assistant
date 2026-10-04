import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamBufferImpl,
  createSessionChunkHandler,
} from './streamBuffer.ts';
import type { RafScheduler } from './streamBuffer.ts';
import type { GeminiStreamChunk } from '../../../types/gemini.ts';

class MockRafScheduler implements RafScheduler {
  private nextId = 1;
  private callbacks = new Map<number, () => void>();
  public cancelledIds: number[] = [];

  schedule(cb: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, cb);
    return id;
  }

  cancel(id: number): void {
    this.cancelledIds.push(id);
    this.callbacks.delete(id);
  }

  triggerFrame(): void {
    const pending = Array.from(this.callbacks.values());
    this.callbacks.clear();
    for (const cb of pending) {
      cb();
    }
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }
}

test('StreamBuffer coalesces multiple appends in the same frame into a single flush', () => {
  const scheduler = new MockRafScheduler();
  const flushCalls: string[] = [];
  const buffer = new StreamBufferImpl((text) => flushCalls.push(text), scheduler);

  buffer.append('Hello ');
  buffer.append('world');
  buffer.append('!');

  // State update has NOT fired yet; all chunks are pending in buffer
  assert.equal(flushCalls.length, 0);
  assert.equal(buffer.pendingText, 'Hello world!');
  assert.equal(scheduler.pendingCount, 1);

  // RAF tick runs
  scheduler.triggerFrame();

  // Exactly one flush call with the combined text
  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0], 'Hello world!');
  assert.equal(buffer.pendingText, '');
  assert.equal(buffer.rafId, null);
});

test('StreamBuffer.flush() immediately triggers state update and cancels pending RAF', () => {
  const scheduler = new MockRafScheduler();
  const flushCalls: string[] = [];
  const buffer = new StreamBufferImpl((text) => flushCalls.push(text), scheduler);

  buffer.append('Immediate text');
  assert.equal(flushCalls.length, 0);
  assert.notEqual(buffer.rafId, null);

  const scheduledId = buffer.rafId as number;

  buffer.flush();

  // Flushed immediately
  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0], 'Immediate text');
  assert.equal(buffer.pendingText, '');
  assert.equal(buffer.rafId, null);

  // RAF was cancelled
  assert.ok(scheduler.cancelledIds.includes(scheduledId));

  // Triggering next frame does not duplicate flush
  scheduler.triggerFrame();
  assert.equal(flushCalls.length, 1);
});

test('StreamBuffer.dispose() cancels pending RAF and clears pendingText without calling onFlush', () => {
  const scheduler = new MockRafScheduler();
  const flushCalls: string[] = [];
  const buffer = new StreamBufferImpl((text) => flushCalls.push(text), scheduler);

  buffer.append('Text that should be discarded on unmount');
  const scheduledId = buffer.rafId as number;

  buffer.dispose();

  assert.equal(buffer.pendingText, '');
  assert.equal(buffer.rafId, null);
  assert.ok(scheduler.cancelledIds.includes(scheduledId));
  assert.equal(flushCalls.length, 0);

  scheduler.triggerFrame();
  assert.equal(flushCalls.length, 0);
});

test('createSessionChunkHandler ignores chunks from stale or previous sessions', () => {
  const scheduler = new MockRafScheduler();
  const flushCalls: string[] = [];
  const buffer = new StreamBufferImpl((text) => flushCalls.push(text), scheduler);

  let activeSessionId = 'session_alpha';
  const handler = createSessionChunkHandler(
    () => activeSessionId,
    buffer,
    {}
  );

  // Chunk with different session ID should be ignored
  const staleChunk: GeminiStreamChunk = {
    session_id: 'session_old_beta',
    chunk: 'Stale chunk content',
    is_done: false,
    error: null,
  };
  const processedStale = handler(staleChunk);
  assert.equal(processedStale, false);
  assert.equal(buffer.pendingText, '');

  // Chunk with matching active session ID should be accepted
  const validChunk: GeminiStreamChunk = {
    session_id: 'session_alpha',
    chunk: 'Active session content',
    is_done: false,
    error: null,
  };
  const processedValid = handler(validChunk);
  assert.equal(processedValid, true);
  assert.equal(buffer.pendingText, 'Active session content');
});

test('createSessionChunkHandler immediately flushes buffer on terminal is_done', () => {
  const scheduler = new MockRafScheduler();
  const flushCalls: string[] = [];
  let doneCalled = false;

  const buffer = new StreamBufferImpl((text) => flushCalls.push(text), scheduler);
  const handler = createSessionChunkHandler(
    () => 'session_123',
    buffer,
    {
      onDone: () => {
        doneCalled = true;
      },
    }
  );

  // First chunk arrives
  handler({
    session_id: 'session_123',
    chunk: 'Partial code hint ',
    is_done: false,
    error: null,
  });

  assert.equal(flushCalls.length, 0);
  assert.equal(buffer.pendingText, 'Partial code hint ');

  // Final chunk arrives with is_done: true
  handler({
    session_id: 'session_123',
    chunk: 'completed.',
    is_done: true,
    error: null,
  });

  // is_done triggers an immediate flush, not waiting for next RAF
  assert.equal(doneCalled, true);
  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0], 'Partial code hint completed.');
  assert.equal(buffer.pendingText, '');
});

test('createSessionChunkHandler flushes buffer and notifies onError on error payload', () => {
  const scheduler = new MockRafScheduler();
  const flushCalls: string[] = [];
  let receivedError: string | null = null;

  const buffer = new StreamBufferImpl((text) => flushCalls.push(text), scheduler);
  const handler = createSessionChunkHandler(
    () => 'session_err',
    buffer,
    {
      onError: (err) => {
        receivedError = err;
      },
    }
  );

  // Partial chunk before error
  handler({
    session_id: 'session_err',
    chunk: 'Leading tokens before failure. ',
    is_done: false,
    error: null,
  });

  // Error event arrives
  handler({
    session_id: 'session_err',
    chunk: '',
    is_done: true,
    error: 'Gemini 429: Resource exhausted',
  });

  // Flushes pending tokens so user does not lose output, and calls onError
  assert.equal(receivedError, 'Gemini 429: Resource exhausted');
  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0], 'Leading tokens before failure. ');
  assert.equal(buffer.pendingText, '');
});

test('Simulated unmount cancels RAF scheduler and unlistens event listener', () => {
  const scheduler = new MockRafScheduler();
  const flushCalls: string[] = [];
  let unlistenCalled = false;

  const buffer = new StreamBufferImpl((text) => flushCalls.push(text), scheduler);
  const unlistenMock = () => {
    unlistenCalled = true;
  };

  buffer.append('Pending before unmount');
  assert.notEqual(buffer.rafId, null);

  // Simulate cleanupListener on unmount
  unlistenMock();
  buffer.dispose();

  assert.equal(unlistenCalled, true);
  assert.equal(buffer.pendingText, '');
  assert.equal(buffer.rafId, null);

  // Advancing frames produces no callbacks
  scheduler.triggerFrame();
  assert.equal(flushCalls.length, 0);
});
