import type { GeminiStreamChunk, StreamBuffer } from '../../../types/gemini.ts';

export interface RafScheduler {
  schedule(cb: () => void): number;
  cancel(id: number): void;
}

/**
 * Concrete implementation of StreamBuffer that coalesces stream chunks
 * into requestAnimationFrame cycles to minimize React re-renders.
 */
export class StreamBufferImpl implements StreamBuffer {
  pendingText: string = '';
  rafId: number | null = null;
  private readonly onFlush: (flushedText: string) => void;
  private readonly scheduler: RafScheduler;

  constructor(
    onFlush: (flushedText: string) => void,
    scheduler?: RafScheduler
  ) {
    this.onFlush = onFlush;
    this.scheduler = scheduler ?? {
      schedule: (cb: () => void): number => {
        if (typeof requestAnimationFrame !== 'undefined') {
          return requestAnimationFrame(cb);
        }
        return 0;
      },
      cancel: (id: number): void => {
        if (typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(id);
        }
      },
    };
  }

  append(chunk: string): void {
    if (!chunk) return;
    this.pendingText += chunk;
    if (this.rafId === null) {
      this.rafId = this.scheduler.schedule(() => {
        this.rafId = null;
        this.flush();
      });
    }
  }

  flush(): void {
    if (this.rafId !== null) {
      this.scheduler.cancel(this.rafId);
      this.rafId = null;
    }
    if (this.pendingText.length > 0) {
      const textToFlush = this.pendingText;
      this.pendingText = '';
      this.onFlush(textToFlush);
    }
  }

  dispose(): void {
    if (this.rafId !== null) {
      this.scheduler.cancel(this.rafId);
      this.rafId = null;
    }
    this.pendingText = '';
  }
}

export interface SessionChunkCallbacks {
  onError?: (error: string) => void;
  onDone?: () => void;
}

/**
 * Creates a stream chunk handler that verifies session affinity and routes
 * chunks to the StreamBuffer while ensuring terminal events flush remaining text.
 */
export function createSessionChunkHandler(
  getActiveSessionId: () => string,
  buffer: StreamBuffer,
  callbacks: SessionChunkCallbacks
): (payload: GeminiStreamChunk) => boolean {
  return (payload: GeminiStreamChunk): boolean => {
    if (payload.session_id !== getActiveSessionId()) {
      return false;
    }

    if (payload.chunk) {
      buffer.append(payload.chunk);
    }

    if (payload.error) {
      buffer.flush();
      callbacks.onError?.(payload.error);
    } else if (payload.is_done) {
      buffer.flush();
      callbacks.onDone?.();
    }

    return true;
  };
}
