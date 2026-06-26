"use client";

import Image from "next/image";
import {
  useCallback,
  useState,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  IMAGE_REMOTE_HOSTS,
  UNOPTIMIZED_IMAGE_HOSTS,
} from "@/config/image-hosts.js";

export type OptimizedImageProps = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
  unoptimized?: boolean;
  fallback?: ReactNode;
  onError?: (event: SyntheticEvent<HTMLImageElement, Event>) => void;
};

const failedImageUrls = new Set<string>();

function shouldBypassOptimizer(src: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  if (src.startsWith("data:") || src.startsWith("blob:")) return true;
  try {
    const { hostname, protocol } = new URL(src);
    if (protocol !== "https:" && protocol !== "http:") return true;
    if (UNOPTIMIZED_IMAGE_HOSTS.includes(hostname)) return true;
    return !IMAGE_REMOTE_HOSTS.includes(hostname);
  } catch {
    return true;
  }
}

export function OptimizedImage({
  src,
  alt,
  width = 32,
  height = 32,
  className,
  style,
  unoptimized,
  fallback,
  onError,
}: OptimizedImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(() =>
    failedImageUrls.has(src) ? src : null,
  );
  const failed = failedImageUrls.has(src) || failedSrc === src;

  const handleError = useCallback(
    (event: SyntheticEvent<HTMLImageElement, Event>) => {
      if (failedImageUrls.has(src)) return;
      failedImageUrls.add(src);
      setFailedSrc(src);
      onError?.(event);
    },
    [src, onError],
  );

  if (!src) return null;
  if (failed) return fallback ?? null;

  if (shouldBypassOptimizer(src, unoptimized)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- bypass /_next/image for flaky hosts
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        className={className}
        style={style}
        onError={handleError}
        loading="lazy"
        decoding="async"
      />
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      style={style}
      onError={handleError}
    />
  );
}
