import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RhPermit2StatusBanner } from '@/components/rh/RhPermit2SetupSheet'

describe('RhPermit2StatusBanner', () => {
  it('shows checking instead of unavailable while config resolves', () => {
    const html = renderToStaticMarkup(
      <RhPermit2StatusBanner
        executorConfigured={false}
        executorResolving
        readiness={undefined}
        onSetup={vi.fn()}
      />,
    )
    expect(html).toContain('Checking one-click trade setup')
    expect(html).not.toContain('BatchExecutor is unavailable')
  })
})
