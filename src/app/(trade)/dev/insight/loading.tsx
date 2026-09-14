import React from 'react'

export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6" aria-busy="true" aria-label="Loading Insight">
      <div className="h-7 w-28 rounded-lg bg-white/10" />
      <div className="h-4 w-full max-w-xl rounded-md bg-white/5" />
      <div className="h-9 w-36 rounded-xl bg-white/5 shadow-elev" />
      <div className="h-48 rounded-[20px] bg-gray-900/60 shadow-elev" />
    </div>
  )
}
