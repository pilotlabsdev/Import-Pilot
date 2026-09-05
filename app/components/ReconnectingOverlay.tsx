import { useState, useEffect, useCallback } from "react";

interface ReconnectingOverlayProps {
  onRetry?: () => void;
}

export function ReconnectingOverlay({ onRetry }: ReconnectingOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [maxReached, setMaxReached] = useState(false);

  const doReconnect = useCallback(() => {
    setVisible(true);
    setAttempt(1);

    let retries = 0;
    const maxRetries = 3;
    const baseDelay = 1500;

    const tryReconnect = () => {
      retries++;
      setAttempt(retries);

      if (retries >= maxRetries) {
        setMaxReached(true);
        setTimeout(() => {
          window.location.reload();
        }, 2000);
        return;
      }

      const delay = baseDelay * Math.pow(2, retries - 1);
      setTimeout(() => {
        fetch("/app", { method: "HEAD", cache: "no-store" })
          .then((res) => {
            if (res.ok) {
              window.location.reload();
            } else {
              tryReconnect();
            }
          })
          .catch(() => {
            tryReconnect();
          });
      }, delay);
    };

    tryReconnect();
  }, []);

  useEffect(() => {
    const handleOffline = () => setVisible(true);
    const handleOnline = () => {
      setVisible(true);
      setAttempt(1);
      setTimeout(() => window.location.reload(), 1000);
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data === "shopify:app:auth:expired" || e.data?.type === "shopify:app:auth:expired") {
        doReconnect();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [doReconnect]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 99999,
        background: "var(--p-color-bg-surface, #f6f6f7)",
        borderBottom: "1px solid var(--p-color-border, #e1e3e5)",
        padding: "10px 16px",
        textAlign: "center",
        fontSize: "13px",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        color: "var(--p-color-text, #202223)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
      }}
    >
      <div
        style={{
          width: "16px",
          height: "16px",
          border: "2px solid var(--p-color-border-highlight, #006fbb)",
          borderTopColor: "transparent",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
          flexShrink: 0,
        }}
      />
      <span style={{ fontWeight: 500 }}>
        {maxReached
          ? "Reconectando..."
          : "Reconectando..."}
      </span>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function triggerReconnect() {
  window.postMessage("shopify:app:auth:expired", "*");
}
