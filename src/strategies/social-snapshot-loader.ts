import { fetchSocialRollup } from './social/db'
import type { SocialGateConfig } from './social/types'
import {
  evaluateSocialGate,
  rollupToSocialSnapshot,
  type SocialGateResult,
} from './social-snapshot'

export async function getSocialSnapshot(
  tokenAddress: string,
  atTime: Date = new Date(),
) {
  const rollup = await fetchSocialRollup(tokenAddress)
  return rollupToSocialSnapshot(rollup, atTime)
}

export async function checkSocialGate(
  tokenAddress: string,
  gate: SocialGateConfig | undefined,
  context: { domain: string },
): Promise<SocialGateResult> {
  const snapshot = await getSocialSnapshot(tokenAddress)
  return evaluateSocialGate(snapshot, gate, { tokenAddress, domain: context.domain })
}
