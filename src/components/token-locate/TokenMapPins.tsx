'use client'

export type TokenMapPin = { address: string; symbol?: string | null }

function truncateMint(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

export default function TokenMapPins({
  pins,
  activeAddress,
  onSelect,
  onUnpin,
}: {
  pins: TokenMapPin[]
  activeAddress: string
  onSelect: (address: string) => void
  onUnpin: (address: string) => void
}) {
  if (pins.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs uppercase tracking-wide text-gray-500">Pins</span>
      {pins.map((pin) => {
        const active = pin.address === activeAddress
        return (
          <div
            key={pin.address}
            className={`flex items-center gap-1 rounded-full border px-2 py-1 text-xs ${
              active
                ? 'border-blue-500 bg-blue-950/50 text-white'
                : 'border-gray-700 bg-gray-900 text-gray-300'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(pin.address)}
              className="hover:text-white"
              title={pin.address}
            >
              {pin.symbol ?? truncateMint(pin.address)}
            </button>
            <button
              type="button"
              onClick={() => onUnpin(pin.address)}
              className="text-gray-500 hover:text-red-400"
              aria-label={`Unpin ${pin.address}`}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
