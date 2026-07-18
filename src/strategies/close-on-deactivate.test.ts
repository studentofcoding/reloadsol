import { describe, expect, it } from 'vitest'
import type { BotCloseReason } from '@/utils/bot-position-close'
import type { McapSimCloseReason } from '@/utils/mcap-tracker'

describe('strategy_deactivated close reason', () => {
  it('is a valid BotCloseReason and McapSimCloseReason', () => {
    const bot: BotCloseReason = 'strategy_deactivated'
    const mcap: McapSimCloseReason = 'strategy_deactivated'
    expect(bot).toBe('strategy_deactivated')
    expect(mcap).toBe('strategy_deactivated')
  })
})
