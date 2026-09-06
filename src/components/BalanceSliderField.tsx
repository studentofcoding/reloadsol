"use client";

/**
 * Labeled numeric input paired with a "% of balance" slider — shared by the
 * Buy page (split spend across a batch) and the Robinhood swap panel.
 *
 * Two modes:
 *  - `amount`: the input holds a currency amount; the slider maps a percent
 *    of `balance` to that amount (`balance * pct / 100`), and typing an
 *    amount moves the slider to the matching percent.
 *  - `percent`: both the input and slider hold a raw percentage (e.g. the
 *    swap panel's "Sell %"). No balance is needed.
 *
 * The parent owns the value string (and currency state). The slider is the
 * derived readout, not the source of truth.
 */

export interface BalanceSliderFieldProps {
  mode?: "amount" | "percent";
  /** Current value (currency amount in `amount` mode, percent in `percent` mode). */
  value: string;
  /** Write the new value back. */
  onChange: (value: string) => void;
  /** Amount mode only: spendable balance in the same unit as `value`. */
  balance?: number | null;
  /** Amount mode only: decimals when writing balance-derived amounts. */
  decimals?: number;
  /** Slider floor (%). Buy mode keeps users above the $ min; percent mode usually 1. */
  minPercent?: number;
  /** Slider ceiling (%). */
  maxPercent?: number;
  /** Disables the numeric input (and unit adornment). */
  disabled?: boolean;
  /** Extra condition disabling just the slider (e.g. not connected / no balance). */
  sliderDisabled?: boolean;
  /** Extra condition disabling just the unit button (e.g. locked currency). */
  unitDisabled?: boolean;
  inputId?: string;
  label?: string;
  /** Adornment text shown at the right of the input ("SOL", "ETH", "%"). */
  unit?: string;
  /** When provided, the adornment is a clickable currency toggle. */
  onToggleUnit?: () => void;
  placeholder?: string;
  /** Numeric input `step` attribute. */
  step?: string;
  /** Numeric input minimum (amount mode: min human amount; percent mode: 1). */
  inputMin?: number;
  /** Optional hint rendered under the input. */
  hint?: React.ReactNode;
}

export default function BalanceSliderField({
  mode = "amount",
  value,
  onChange,
  balance,
  decimals = 2,
  minPercent = 1,
  maxPercent = 96,
  disabled,
  sliderDisabled,
  unitDisabled,
  inputId,
  label,
  unit,
  onToggleUnit,
  placeholder,
  step = "any",
  inputMin,
  hint,
}: BalanceSliderFieldProps) {
  const isPercentMode = mode === "percent";
  const rawNum = parseFloat(value);

  const displayPercent = () => {
    if (isPercentMode) {
      if (!Number.isFinite(rawNum)) return minPercent;
      return Math.min(maxPercent, Math.max(minPercent, Math.round(rawNum)));
    }
    if (!(balance != null && balance > 0)) return minPercent;
    if (!Number.isFinite(rawNum) || rawNum <= 0) return minPercent;
    const pct = Math.round((rawNum / balance) * 100);
    return Math.min(maxPercent, Math.max(minPercent, pct));
  };

  const sliderValue = displayPercent();
  // Amount mode: hide the slider until a spendable balance is known. Percent
  // mode has no balance dependency, so it is always shown.
  const showSlider = isPercentMode || balance != null;
  const canSlide = isPercentMode
    ? true
    : balance != null && balance > 0 && !sliderDisabled;
  const sliderLocked = !showSlider || disabled || (isPercentMode ? false : !canSlide);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const percent = Math.min(
      maxPercent,
      Math.max(minPercent, parseInt(e.target.value, 10) || minPercent),
    );
    if (isPercentMode) {
      onChange(String(percent));
      return;
    }
    if (!(balance != null && balance > 0)) return;
    onChange(((balance * percent) / 100).toFixed(decimals));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-1">
        {label ? (
          <label
            htmlFor={inputId}
            className="block text-sm font-semibold text-gray-200 uppercase tracking-wide"
          >
            {label}
          </label>
        ) : (
          <span />
        )}
        {showSlider && (
          <div className="flex items-center space-x-3">
            <input
              type="range"
              min={minPercent}
              max={maxPercent}
              step={1}
              value={sliderValue}
              onChange={handleSliderChange}
              disabled={sliderLocked}
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
            />
            <span className="text-xs text-gray-400 font-mono w-12 text-right">
              {sliderValue}%
            </span>
          </div>
        )}
      </div>

      <div className="relative">
        <input
          id={inputId}
          type="number"
          step={isPercentMode ? "1" : step}
          min={
            isPercentMode
              ? 1
              : inputMin && inputMin > 0
                ? inputMin
                : 0
          }
          max={isPercentMode ? maxPercent : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl shadow-inner text-white placeholder-gray-400 focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
          disabled={disabled}
        />
        {unit && (
          <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
            {onToggleUnit ? (
              <button
                type="button"
                onClick={onToggleUnit}
                className="text-gray-400 hover:text-white font-mono text-sm px-2 py-1 rounded transition-colors duration-200 hover:bg-gray-700"
                disabled={disabled || unitDisabled}
              >
                {unit}
              </button>
            ) : (
              <span className="text-gray-400 font-mono text-sm px-2 py-1">
                {unit}
              </span>
            )}
          </div>
        )}
      </div>

      {hint ? <div className="text-xs text-gray-500">{hint}</div> : null}
    </div>
  );
}
