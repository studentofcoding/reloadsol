import { NextRequest, NextResponse } from 'next/server'
import {
  loadStrategyOutcomeById,
  updateStrategyOutcomeFeatures,
} from '@/strategies/db'
import type { OutcomeMlLabel } from '@/strategies/types'

export const dynamic = 'force-dynamic'

const VALID_LABELS: OutcomeMlLabel[] = ['skip', 'interesting', 'anomaly']

function isValidLabel(value: unknown): value is OutcomeMlLabel {
  return typeof value === 'string' && VALID_LABELS.includes(value as OutcomeMlLabel)
}

type PatchBody = {
  ml_label?: OutcomeMlLabel | null
  ml_note?: string | null
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const body = (await request.json()) as PatchBody

    const existing = await loadStrategyOutcomeById(id)
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Outcome not found' },
        { status: 404 },
      )
    }

    const featurePatch: Record<string, unknown> = {}

    if ('ml_label' in body) {
      if (body.ml_label === null) {
        featurePatch.ml_label = null
        featurePatch.ml_labeled_at = null
      } else if (isValidLabel(body.ml_label)) {
        featurePatch.ml_label = body.ml_label
        featurePatch.ml_labeled_at = new Date().toISOString()
      } else {
        return NextResponse.json(
          { success: false, error: 'Invalid ml_label' },
          { status: 400 },
        )
      }
    }

    if ('ml_note' in body) {
      featurePatch.ml_note =
        body.ml_note === null || body.ml_note === undefined
          ? null
          : String(body.ml_note).trim().slice(0, 2000)
    }

    if (Object.keys(featurePatch).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No valid fields to update' },
        { status: 400 },
      )
    }

    const result = await updateStrategyOutcomeFeatures(id, featurePatch)
    if (!result.ok || !result.row) {
      return NextResponse.json(
        { success: false, error: result.error ?? 'Update failed' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, outcome: result.row })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
