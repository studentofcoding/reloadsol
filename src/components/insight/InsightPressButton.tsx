import type { ButtonHTMLAttributes } from 'react'
import { insightPress, insightPressQuiet } from '@/components/insight/insight-ui'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Disable press scale where motion would distract (better-ui `static`). */
  quiet?: boolean
}

export default function InsightPressButton({
  quiet = false,
  className = '',
  type = 'button',
  ...props
}: Props) {
  return (
    <button
      type={type}
      className={`${quiet ? insightPressQuiet : insightPress} ${className}`}
      {...props}
    />
  )
}
