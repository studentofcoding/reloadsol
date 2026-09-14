import React from 'react'
import { insightCard } from '@/components/insight/insight-ui'

export default function Loading() {
  return (
    <div
      className="mx-auto max-w-7xl space-y-8 px-4 py-8"
      aria-busy="true"
      aria-label="Loading Insight"
    >
      <div className="h-7 w-28 rounded-lg bg-white/10" />
      <div className="h-4 w-full max-w-xl rounded-md bg-white/5" />
      <div className="material-tertiary h-9 w-36 rounded-xl" />
      <div className={`${insightCard} h-48`} />
    </div>
  )
}
