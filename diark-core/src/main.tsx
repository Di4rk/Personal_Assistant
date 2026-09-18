import React, { Component, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class RootErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[DIARK Fatal UI Error]:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "100vh",
          backgroundColor: "#09090b",
          color: "#f87171",
          padding: "32px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          zIndex: 99999
        }}>
          <h2 style={{ fontSize: "18px", fontWeight: "bold", color: "#ef4444" }}>
            [DIARK // OS] Lỗi khởi chạy giao diện (UI Crash)
          </h2>
          <pre style={{
            backgroundColor: "#18181b",
            padding: "16px",
            borderRadius: "8px",
            border: "1px solid #3f3f46",
            color: "#f4f4f5",
            fontSize: "12px",
            overflow: "auto",
            whiteSpace: "pre-wrap"
          }}>
            {this.state.error?.stack || this.state.error?.message || String(this.state.error)}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 16px",
              backgroundColor: "#27272a",
              color: "#f4f4f5",
              border: "1px solid #3f3f46",
              borderRadius: "6px",
              cursor: "pointer",
              width: "fit-content"
            }}
          >
            Tải lại ứng dụng (Reload)
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

console.log("[DIARK // OS] Booting frontend runtime...");

const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </React.StrictMode>,
  );
} else {
  console.error("[DIARK // OS] #root element not found!");
}

