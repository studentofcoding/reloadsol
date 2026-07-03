import React from "react";

type ScrollableMenuRowProps = {
  children: React.ReactNode;
  /** Outer wrapper classes (border, margin, etc.) */
  className?: string;
  /** Inner flex row classes */
  innerClassName?: string;
  /** Edge-to-edge scroll on small screens */
  bleed?: boolean;
};

/** Horizontal scroll row for tab menus on mobile. */
export default function ScrollableMenuRow({
  children,
  className = "",
  innerClassName = "gap-2",
  bleed = true,
}: ScrollableMenuRowProps) {
  const bleedClass = bleed ? "-mx-4 px-4 md:mx-0 md:px-0" : "";
  return (
    <div
      className={`overflow-x-auto scrollbar-hide scroll-smooth ${bleedClass} ${className}`.trim()}
    >
      <div className={`flex flex-nowrap min-w-max items-center ${innerClassName}`.trim()}>
        {children}
      </div>
    </div>
  );
}
