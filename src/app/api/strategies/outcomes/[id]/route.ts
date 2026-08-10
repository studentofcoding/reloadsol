import { NextRequest, NextResponse } from 'next/server'
import {
  loadStrategyOutcomeById,
  updateStrategyOutcomeFeatures,
} from '@/strategies/db'
import { applyManualTrainingClass } from '@/strategies/outcome-labeling'
import { isLabeledTrainingClass } from '@/strategies/outcome-features'
import type { OutcomeMlCondition, OutcomeMlLabel } from '@/strategies/types'


const VALID_LABELS: OutcomeMlLabel[] = ['skip', 'interesting', 'anomaly']
const VALID_CONDITIONS: OutcomeMlCondition[] = [
  'old_chart',
  'price_topped',
  'new_chart',
]

function isValidLabel(value: unknown): value is OutcomeMlLabel {
  return typeof value === 'string' && VALID_LABELS.includes(value as OutcomeMlLabel)
}

function isValidCondition(value: unknown): value is OutcomeMlCondition {
  return (
    typeof value === 'string' &&
    VALID_CONDITIONS.includes(value as OutcomeMlCondition)
  )
}

type PatchBody = {
  ml_label?: OutcomeMlLabel | null
  ml_condition?: OutcomeMlCondition | null
  ml_note?: string | null
  ml_manual?: boolean
  training_class?: number | null
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

    if ('ml_condition' in body) {
      if (body.ml_condition === null) {
        featurePatch.ml_condition = null
        featurePatch.ml_condition_at = null
      } else if (isValidCondition(body.ml_condition)) {
        featurePatch.ml_condition = body.ml_condition
        featurePatch.ml_condition_at = new Date().toISOString()
      } else {
        return NextResponse.json(
          { success: false, error: 'Invalid ml_condition' },
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

    if (body.ml_manual === true) {
      featurePatch.ml_manual = true
    }

    if ('training_class' in body) {
      if (body.training_class === null) {
        featurePatch.training_class = null
      } else if (isLabeledTrainingClass(body.training_class)) {
        const merged = applyManualTrainingClass(
          { ...(existing.features ?? {}), ...featurePatch },
          body.training_class,
        )
        featurePatch.training_class = merged.training_class
        featurePatch.ml_manual = merged.ml_manual
        if (merged.ml_label) featurePatch.ml_label = merged.ml_label
      } else {
        return NextResponse.json(
          { success: false, error: 'Invalid training_class (must be 0–4)' },
          { status: 400 },
        )
      }
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
