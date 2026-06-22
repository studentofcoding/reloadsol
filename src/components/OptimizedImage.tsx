"use client";

import Image from "next/image";
import { useState, type CSSProperties, type SyntheticEvent } from "react";
import { IMAGE_REMOTE_HOSTS } from "@/config/image-hosts.js";

export type OptimizedImageProps = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
  unoptimized?: boolean;
  onError?: (event: SyntheticEvent<HTMLImageElement, Event>) => void;
};

function shouldUseUnoptimized(src: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  if (src.startsWith("data:") || src.startsWith("blob:")) return true;
  try {
    const { hostname, protocol } = new URL(src);
    if (protocol !== "https:" && protocol !== "http:") return true;
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
  onError,
}: OptimizedImageProps) {
  const [hidden, setHidden] = useState(false);

  if (!src || hidden) return null;

  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      style={style}
      unoptimized={shouldUseUnoptimized(src, unoptimized)}
      onError={(event) => {
        if (onError) {
          onError(event);
          return;
        }
        setHidden(true);
      }}
    />
  );
}
