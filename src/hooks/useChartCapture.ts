import { useState, useCallback } from "react";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { fetchTokenPricesForTracking } from "@/utils/trading-tracker";

interface SignalData {
  initial_price?: number;
  label?: string;
  source?: string;
  token_symbol?: string;
  market_cap?: number;
  price?: number;
}

export interface CaptureResult {
  tokenAddress: string;
  result: {
    end_time: string;
    initial_price: number;
    final_price: number;
    pnl_percentage: number;
  };
  imageBase64: string;
}

export function useChartCapture() {
  const { network } = useAppNetwork();
  const [isOpen, setIsOpen] = useState(false);
  const [data, setData] = useState<CaptureResult | null>(null);
  const [status, setStatus] = useState("");
  const [isCapturing, setIsCapturing] = useState(false);

  // Store context for saving later
  const [currentContext, setCurrentContext] = useState<SignalData | null>(null);

  const startCapture = useCallback(
    async (tokenAddress: string, context?: SignalData) => {
      document.body.style.cursor = "wait";
      setStatus(`Capturing chart for ${tokenAddress.slice(0, 8)}...`);
      setIsCapturing(true);
      setCurrentContext(context || null);

      try {
        // Server-side capture
        const res = await fetch("/api/capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokenAddress }),
        });
        const json = await res.json();

        if (!json.success) {
          throw new Error(json.error || "Capture failed");
        }

        const imageBase64 = json.imageBase64;

        // Calculate PnL
        const initialPrice = context?.initial_price || 0;

        // Fetch fresh price
        const prices = await fetchTokenPricesForTracking([tokenAddress]);
        const currentPrice = prices[tokenAddress] || 0;

        const pnl =
          initialPrice > 0
            ? ((currentPrice - initialPrice) / initialPrice) * 100
            : 0;

        const result = {
          end_time: new Date().toISOString(),
          initial_price: initialPrice,
          final_price: currentPrice,
          pnl_percentage: parseFloat(pnl.toFixed(2)),
        };

        setData({
          tokenAddress,
          result,
          imageBase64,
        });
        setIsOpen(true);
        setStatus("");
      } catch (e) {
        console.error("End tracking failed", e);
        setStatus("Failed to capture chart");
      } finally {
        document.body.style.cursor = "default";
        setIsCapturing(false);
      }
    },
    []
  );

  const retakeCapture = useCallback(async () => {
    if (!data?.tokenAddress) return;

    try {
      setStatus("Retaking capture...");
      const res = await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenAddress: data.tokenAddress }),
      });
      const json = await res.json();

      if (!json.success) throw new Error(json.error);

      const imageBase64 = json.imageBase64;
      setData((prev) => (prev ? { ...prev, imageBase64 } : null));
      setStatus("Capture updated!");
      setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      console.error("Retake failed", e);
      setStatus("Capture cancelled or failed");
    }
  }, [data?.tokenAddress]);

  const saveResult = useCallback(async () => {
    if (!data) return;

    setStatus("Saving result...");
    try {
      let labelToSave = currentContext?.label;
      if (labelToSave === "mcap_tracker" || !labelToSave) {
        labelToSave = "watching";
      }

      const payload: any = {
        tokenAddress: data.tokenAddress,
        result: data.result,
        imageReference: data.imageBase64,
        source: currentContext?.source || "manual",
        tokenSymbol: currentContext?.token_symbol,
        mcap: currentContext?.market_cap,
        price: currentContext?.price,
        initialPrice: currentContext?.initial_price,
        label: labelToSave,
        chain: network,
      };

      await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      setStatus("Tracking ended & saved!");
      setIsOpen(false);
      setData(null);
      setCurrentContext(null);
      setTimeout(() => setStatus(""), 3000);
    } catch (e) {
      console.error("Save failed", e);
      setStatus("Failed to save result");
    }
  }, [data, currentContext, network]);

  return {
    isOpen,
    data,
    status,
    isCapturing,
    startCapture,
    retakeCapture,
    saveResult,
    close: () => setIsOpen(false),
  };
}
