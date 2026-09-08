import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

interface ReconnectingOverlayProps {
  onRetry?: () => void;
}

export function ReconnectingOverlay({ onRetry }: ReconnectingOverlayProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const reloadScheduled = useRef(false);

  // Auth expiry: show overlay, reload after 1s (App Bridge handles re-auth)
  // useRef prevents double-reload if component re-renders
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data === "shopify:app:auth:expired" || e.data?.type === "shopify:app:auth:expired") {
        setVisible(true);
        if (!reloadScheduled.current) {
          reloadScheduled.current = true;
          setTimeout(() => window.location.reload(), 1000);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Offline: show overlay. Online: reload. Debounced to prevent loops.
  useEffect(() => {
    const handleOffline = () => setVisible(true);
    const handleOnline = () => {
      if (!reloadScheduled.current) {
        setVisible(true);
        reloadScheduled.current = true;
        setTimeout(() => window.location.reload(), 500);
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: "12px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 99999,
        background: "var(--p-color-bg-surface, #ffffff)",
        border: "1px solid var(--p-color-border, #e1e3e5)",
        borderRadius: "8px",
        padding: "10px 20px",
        fontSize: "13px",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        color: "var(--p-color-text, #202223)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
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
        {t("systemError.reconnecting")}
      </span>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function triggerReconnect() {
  window.postMessage("shopify:app:auth:expired", "*");
}
