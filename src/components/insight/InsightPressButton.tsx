import type { ButtonHTMLAttributes } from 'react'
import {
  ctaPress,
  insightPress,
  insightPressQuiet,
} from '@/components/insight/insight-ui'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Disable press scale where motion would distract (better-ui `static`). */
  quiet?: boolean
  /** Kinetics squish for primary CTAs. Mutually exclusive with default 0.96. */
  punch?: boolean
}

export default function InsightPressButton({
  quiet = false,
  punch = false,
  className = '',
  type = 'button',
  ...props
}: Props) {
  const motion = punch ? ctaPress : quiet ? insightPressQuiet : insightPress
  return (
    <button
      type={type}
      data-slot="button"
      data-variant={punch ? 'primary' : quiet ? 'quiet' : 'default'}
      className={`${motion} ${className}`}
      {...props}
    />
  )
}
