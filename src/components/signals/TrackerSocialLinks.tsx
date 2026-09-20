import { socialUrl } from '@/utils/social-url'
import type { TrackerSocialLinks as Social } from '@/utils/tracker-social-join'

export function TrackerSocialLinks({
  social,
  organicScore,
}: {
  social?: Social
  organicScore?: number | null
}) {
  const twitter = socialUrl(social?.twitter, 'twitter')
  const telegram = socialUrl(social?.telegram, 'telegram')
  const website = socialUrl(social?.website, 'website')
  const showOrganic = organicScore != null && Number.isFinite(organicScore)
  if (!twitter && !telegram && !website && !showOrganic) return null

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs mt-1">
      {twitter && (
        <a
          href={twitter}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-sky-400 hover:underline"
        >
          𝕏 Twitter
        </a>
      )}
      {telegram && (
        <a
          href={telegram}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-blue-400 hover:underline"
        >
          ✈ Telegram
        </a>
      )}
      {website && (
        <a
          href={website}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-gray-300 hover:underline"
        >
          🌐 Website
        </a>
      )}
      {showOrganic && (
        <span className="rounded bg-emerald-900/50 border border-emerald-700 px-2 py-0.5 text-emerald-200">
          organic {Math.round(organicScore)}
        </span>
      )}
    </div>
  )
}
