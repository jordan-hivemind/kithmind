"use client";

// The admin panel's frame: the navigation beside the screen, with a drag
// handle between them. The width is remembered in `localStorage` and a
// double-click restores the default, the same as a table column.

import { useEffect, useState } from "react";

const KEY = "kith:admin-nav-width";
const DEFAULT_WIDTH = 168;
const MIN_WIDTH = 96;
const MAX_WIDTH = 320;

const clamp = (value: number) =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));

export function AdminShell({
  nav,
  children,
}: {
  nav: React.ReactNode;
  children: React.ReactNode;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(KEY));
      if (saved > 0) setWidth(clamp(saved));
    } catch {
      // Storage unavailable: the default width is fine.
    }
  }, []);

  const remember = (value: number) => {
    setWidth(value);
    try {
      window.localStorage.setItem(KEY, String(value));
    } catch {
      // The width just does not persist this session.
    }
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let latest = width;
    const move = (moved: PointerEvent) => {
      latest = clamp(startWidth + moved.clientX - startX);
      setWidth(latest);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      remember(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <div className="flex min-h-[70vh] flex-col gap-5 md:flex-row md:gap-6">
      <div
        className="relative md:w-[var(--admin-nav-width)] md:shrink-0"
        style={{ "--admin-nav-width": `${width}px` } as React.CSSProperties}
      >
        {nav}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize navigation"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          tabIndex={0}
          onPointerDown={startDrag}
          onDoubleClick={() => remember(DEFAULT_WIDTH)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") remember(clamp(width - 16));
            if (event.key === "ArrowRight") remember(clamp(width + 16));
          }}
          className="absolute inset-y-0 -right-1.5 hidden w-3 cursor-col-resize touch-none hover:bg-accent-100 focus-visible:bg-accent-100 md:block"
        />
      </div>
      <section className="min-w-0 flex-1">{children}</section>
    </div>
  );
}
