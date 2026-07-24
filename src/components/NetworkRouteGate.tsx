'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import {
  defaultPathForNetwork,
  isNetworkGatedRoute,
  routeSupportsNetwork,
} from '@/config/route-network'

/** Redirect when the current path is not allowed on the active app network. */
export default function NetworkRouteGate({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname() || ''
  const router = useRouter()
  const { network } = useAppNetwork()

  useEffect(() => {
    if (!isNetworkGatedRoute(pathname)) return
    if (routeSupportsNetwork(pathname, network)) return
    router.replace(defaultPathForNetwork(network))
  }, [pathname, network, router])

  if (
    isNetworkGatedRoute(pathname) &&
    !routeSupportsNetwork(pathname, network)
  ) {
    return null
  }

  return <>{children}</>
}
