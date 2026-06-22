import { OptimizedImage } from "@/components/OptimizedImage";
import React from "react";

interface ChartCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: {
    tokenAddress: string;
    result: any;
    imageBase64: string;
  } | null;
  onRetake: () => void;
  onSave: () => void;
}

export function ChartCaptureModal({
  isOpen,
  onClose,
  data,
  onRetake,
  onSave,
}: ChartCaptureModalProps) {
  if (!isOpen || !data) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-gray-900 rounded-xl border border-gray-700 w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-800 bg-gray-800/50">
          <h3 className="text-lg font-semibold text-white">
            Confirm Trade Result
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Result Stats */}
          <div className="grid grid-cols-4 gap-4 bg-gray-800/30 p-4 rounded-lg border border-gray-700/50">
            <div>
              <div className="text-xs text-gray-400">Initial Price</div>
              <div className="text-lg font-mono text-white">
                ${data.result.initial_price?.toFixed(6)}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-400">Final Price</div>
              <div className="text-lg font-mono text-white">
                ${data.result.final_price?.toFixed(6)}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-400">PnL</div>
              <div
                className={`text-lg font-bold ${
                  data.result.pnl_percentage >= 0
                    ? "text-green-400"
                    : "text-red-400"
                }`}
              >
                {data.result.pnl_percentage > 0 ? "+" : ""}
                {data.result.pnl_percentage}%
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-400">Time</div>
              <div className="text-sm text-gray-300 mt-1">
                {new Date(data.result.end_time).toLocaleTimeString()}
              </div>
            </div>
          </div>

          {/* Screenshot Preview */}
          <div className="relative aspect-video w-full bg-black rounded-lg border border-gray-800 overflow-hidden group">
            <OptimizedImage
              src={data.imageBase64}
              alt="Chart Capture"
              className="w-full h-full object-contain"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-800">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onRetake}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg font-medium transition-colors"
            >
              Retake
            </button>
            <button
              onClick={onSave}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
            >
              Approve & Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
