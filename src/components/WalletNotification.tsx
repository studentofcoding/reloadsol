"use client";

interface WalletNotificationPayload {
  publicKey?: string;
  shortAddress?: string;
  walletName?: string;
}

const showNotification = (
  message: string,
  type: "success" | "error" | "info" = "info",
) => {
  if (typeof window === "undefined") return;

  console.log(`[wallet:${type}] ${message}`);

  const notification = document.createElement("div");
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${type === "error" ? "#ef4444" : type === "success" ? "#10b981" : "#3b82f6"};
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    z-index: 9999;
    font-family: system-ui, -apple-system, sans-serif;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  `;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    document.body.removeChild(notification);
  }, 3000);
};

export const WalletNotification = {
  onConnect: ({ shortAddress, walletName }: WalletNotificationPayload) => {
    sessionStorage.removeItem("hasDisconnected");
    showNotification(`Connected to ${walletName} (${shortAddress})`, "success");
  },
  onConnecting: ({ walletName }: WalletNotificationPayload) => {
    showNotification(`Connecting to ${walletName}...`, "info");
  },
  onDisconnect: ({ walletName }: WalletNotificationPayload) => {
    showNotification(`Disconnected from ${walletName}`, "info");
  },
  onNotInstalled: ({ walletName }: WalletNotificationPayload) => {
    showNotification(`${walletName} is not installed`, "error");
  },
};
