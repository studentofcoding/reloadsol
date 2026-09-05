import React from "react";
import TokenSkeleton from "@/components/TokenSkeleton";

export default function Loading() {
  return <TokenSkeleton count={3} variant="progressive" />;
}
