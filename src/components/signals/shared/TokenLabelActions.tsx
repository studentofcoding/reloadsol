"use client";

import React from "react";

export type KanbanLabel = "watching" | "potential" | "rugged";

const LABELS: { id: KanbanLabel; label: string; active: string; idle: string }[] =
  [
    {
      id: "watching",
      label: "Watch",
      active: "bg-gray-600 text-white",
      idle: "bg-gray-800 text-gray-400 hover:bg-gray-700",
    },
    {
      id: "potential",
      label: "Potential",
      active: "bg-green-600 text-white",
      idle: "bg-gray-800 text-gray-400 hover:bg-gray-700",
    },
    {
      id: "rugged",
      label: "Rugged",
      active: "bg-red-600 text-white",
      idle: "bg-gray-800 text-gray-400 hover:bg-gray-700",
    },
  ];

type TokenLabelActionsProps = {
  currentLabel?: string | null;
  onLabel: (label: KanbanLabel) => void;
  disabled?: boolean;
  size?: "sm" | "md";
};

/** Rugged / potential / watching label buttons (Signals kanban + live). */
export default function TokenLabelActions({
  currentLabel,
  onLabel,
  disabled,
  size = "sm",
}: TokenLabelActionsProps) {
  const pad = size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm";

  return (
    <div className="flex flex-wrap gap-1">
      {LABELS.map(({ id, label, active, idle }) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          onClick={() => onLabel(id)}
          className={`rounded font-medium transition-colors disabled:opacity-50 ${pad} ${
            currentLabel === id ? active : idle
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
