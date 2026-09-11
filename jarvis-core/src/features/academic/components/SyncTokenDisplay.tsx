import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServerStatus =
  | { kind: 'loading' }
  | { kind: 'online'; port: number }
  | { kind: 'failed' }
  | { kind: 'unknown' };

// ---------------------------------------------------------------------------
// SyncTokenDisplay Component
// ---------------------------------------------------------------------------

/**
 * SyncTokenDisplay — hiển thị:
 * 1. Trạng thái loopback sync server (ONLINE / PORT_BIND_FAILED / đang tải).
 * 2. Sync token dùng để dán vào Tampermonkey userscript.
 * 3. Nút "Copy Token" một chạm kèm hướng dẫn ngắn.
 * 4. Tự động refresh academic data khi nhận event "academic-data-synced".
 */
export function SyncTokenDisplay({
  onSyncComplete,
}: {
  onSyncComplete?: () => void;
}) {
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ kind: 'loading' });
  const [syncToken, setSyncToken] = useState<string>('');
  const [tokenLoading, setTokenLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  // Load sync token from backend
  const loadToken = useCallback(async () => {
    setTokenLoading(true);
    try {
      const token = await invoke<string>('get_sync_token');
      setSyncToken(token);
    } catch (err) {
      console.error('[SyncTokenDisplay] Lỗi get_sync_token:', err);
    } finally {
      setTokenLoading(false);
    }
  }, []);

  useEffect(() => {
    loadToken();

    // Lắng nghe trạng thái sync server
    let unlistenStatus: UnlistenFn | undefined;
    let unlistenSync: UnlistenFn | undefined;

    listen<string>('sync-server-status', (event) => {
      const payload = event.payload;
      if (payload.startsWith('ONLINE:')) {
        const port = parseInt(payload.replace('ONLINE:', ''), 10);
        setServerStatus({ kind: 'online', port });
      } else if (payload === 'PORT_BIND_FAILED') {
        setServerStatus({ kind: 'failed' });
      }
    }).then((fn) => {
      unlistenStatus = fn;
    });

    // Lắng nghe event khi có dữ liệu mới được sync từ portal
    listen('academic-data-synced', () => {
      setLastSyncedAt(new Date());
      onSyncComplete?.();
    }).then((fn) => {
      unlistenSync = fn;
    });

    return () => {
      unlistenStatus?.();
      unlistenSync?.();
    };
  }, [loadToken, onSyncComplete]);

  const handleCopyToken = useCallback(async () => {
    if (!syncToken) return;
    try {
      await navigator.clipboard.writeText(syncToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback nếu Clipboard API không khả dụng trong webview
      const el = document.createElement('textarea');
      el.value = syncToken;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [syncToken]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/80 p-5 space-y-4 backdrop-blur-sm">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-200 tracking-wide uppercase">
          UIT Portal Bridge
        </h3>
        <ServerStatusBadge status={serverStatus} />
      </div>

      {/* Sync token field */}
      <div className="space-y-2">
        <label className="text-xs text-zinc-400 font-medium">
          Sync Token (dán vào Tampermonkey script)
        </label>

        <div className="flex gap-2">
          <div className="flex-1 min-w-0">
            {tokenLoading ? (
              <div className="h-9 rounded-lg bg-zinc-800 animate-pulse" />
            ) : (
              <input
                id="sync-token-input"
                type="text"
                readOnly
                value={syncToken}
                className="w-full h-9 px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-mono truncate select-all focus:outline-none focus:ring-1 focus:ring-sky-500"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
            )}
          </div>

          <button
            id="copy-sync-token-btn"
            onClick={handleCopyToken}
            disabled={tokenLoading || !syncToken}
            className={`
              flex items-center gap-1.5 px-3 h-9 rounded-lg text-xs font-medium transition-all duration-150
              ${copied
                ? 'bg-emerald-600 text-white'
                : 'bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white disabled:opacity-40 disabled:cursor-not-allowed'
              }
            `}
          >
            {copied ? (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Đã copy!
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Copy Token
              </>
            )}
          </button>
        </div>
      </div>

      {/* Instructions */}
      <div className="rounded-lg bg-zinc-800/60 border border-zinc-700/40 p-3 space-y-1">
        <p className="text-xs text-zinc-400 font-medium">Hướng dẫn thiết lập:</p>
        <ol className="text-xs text-zinc-500 space-y-1 list-decimal list-inside">
          <li>Cài Tampermonkey trên trình duyệt.</li>
          <li>Nhập script <code className="text-sky-400">uit_portal_sync.user.js</code>.</li>
          <li>Thay <code className="text-amber-400">YOUR_SYNC_TOKEN_HERE</code> bằng token trên.</li>
          <li>Mở trang bảng điểm trên <code className="text-zinc-300">student.uit.edu.vn</code> — Jarvis tự nhận dữ liệu.</li>
        </ol>
      </div>

      {/* Last synced indicator */}
      {lastSyncedAt && (
        <p className="text-xs text-emerald-400 flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          Đã sync lúc {lastSyncedAt.toLocaleTimeString('vi-VN')}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServerStatusBadge
// ---------------------------------------------------------------------------

function ServerStatusBadge({ status }: { status: ServerStatus }) {
  if (status.kind === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-700/60 text-xs text-zinc-400">
        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
        Đang khởi động…
      </span>
    );
  }

  if (status.kind === 'online') {
    return (
      <span
        id="sync-server-status-badge"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-400 font-medium"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        ONLINE :{status.port}
      </span>
    );
  }

  if (status.kind === 'failed') {
    return (
      <span
        id="sync-server-status-badge"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/15 border border-red-500/30 text-xs text-red-400 font-medium"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        PORT BIND FAILED
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-700/60 text-xs text-zinc-500">
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
      Unknown
    </span>
  );
}
