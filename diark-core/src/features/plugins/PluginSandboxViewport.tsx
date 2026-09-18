import React, { useEffect, useRef } from "react";
import { ShieldAlert } from "lucide-react";
import { createPluginSDK } from "@/lib/plugin-sdk";

interface PluginSandboxViewportProps {
  pluginId: string;
}

export const PluginSandboxViewport: React.FC<PluginSandboxViewportProps> = ({ pluginId }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const sdk = createPluginSDK(pluginId);

    const handleMessage = async (event: MessageEvent) => {
      // Bảo đảm message đến từ iframe con
      if (event.source !== iframeRef.current?.contentWindow) return;

      const data = event.data;
      if (!data || typeof data !== "object" || data.pluginId !== pluginId) return;

      const { action, requestId, payload } = data;

      try {
        if (action === "storage_get") {
          const val = await sdk.storage.get(payload.key);
          iframeRef.current?.contentWindow?.postMessage(
            { action: "response", requestId, result: val },
            "*"
          );
        } else if (action === "storage_set") {
          await sdk.storage.set(payload.key, payload.value);
          iframeRef.current?.contentWindow?.postMessage(
            { action: "response", requestId, result: true },
            "*"
          );
        } else if (action === "activity_record") {
          await sdk.activity.record(payload);
          iframeRef.current?.contentWindow?.postMessage(
            { action: "response", requestId, result: true },
            "*"
          );
        }
      } catch (err: unknown) {
        iframeRef.current?.contentWindow?.postMessage(
          { action: "error", requestId, error: String(err) },
          "*"
        );
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [pluginId]);

  // Demo fallback sandbox template
  const sandboxHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body {
            margin: 0;
            padding: 24px;
            background: #090d16;
            color: #94a3b8;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 13px;
          }
          .card {
            background: #0f172a;
            border: 1px solid #1e293b;
            border-radius: 8px;
            padding: 20px;
          }
          h2 { color: #38bdf8; margin-top: 0; font-size: 16px; }
          .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; background: #1e293b; color: #38bdf8; font-size: 11px; margin-bottom: 12px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="tag">THIRD-PARTY ISOLATED SANDBOX</div>
          <h2>Plugin: ${pluginId}</h2>
          <p>Phân hệ đang thực thi an toàn bên trong môi trường cô lập <code>sandbox="allow-scripts"</code>.</p>
          <p>Mọi giao dịch dữ liệu đều bắt buộc đi qua Diark Plugin Bridge RPC.</p>
        </div>
      </body>
    </html>
  `;

  return (
    <div className="w-full rounded-xl border border-slate-800 bg-slate-950 overflow-hidden flex flex-col min-h-[450px]">
      <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs font-mono text-slate-400">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
          <span>SANDBOXED RUNTIME: {pluginId}</span>
        </div>
        <span className="text-[10px] text-slate-500">TRUST_TIER: THIRD_PARTY</span>
      </div>

      <iframe
        ref={iframeRef}
        title={`Plugin: ${pluginId}`}
        sandbox="allow-scripts"
        srcDoc={sandboxHtml}
        className="w-full flex-1 border-0 min-h-[400px]"
      />
    </div>
  );
};
