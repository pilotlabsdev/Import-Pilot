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
        background: "#006fbb",
        color: "white",
        padding: "8px 16px",
        textAlign: "center",
        fontSize: "13px",
        fontFamily: "Inter, sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
      }}
    >
      <div
        style={{
          width: "14px",
          height: "14px",
          border: "2px solid rgba(255,255,255,0.3)",
          borderTopColor: "white",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
      />
      {maxReached
        ? "Reconectando..."
        : `Reconectando... (intento ${attempt}/3)`}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function triggerReconnect() {
  window.postMessage("shopify:app:auth:expired", "*");
}
