import { useId } from 'react';

/** Decorative vector artwork; labels and actions live in the surrounding UI. */
export function StudioArtwork() {
  const gradient = useId();
  return (
    <svg
      className="studio-art"
      viewBox="0 0 144 100"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#d9c4ff" />
          <stop offset="1" stopColor="#8864cb" />
        </linearGradient>
      </defs>
      <ellipse cx="72" cy="91" rx="44" ry="5" fill="#000" opacity=".15" />
      <g transform="rotate(-12 62 42)">
        <rect
          x="17"
          y="17"
          width="88"
          height="59"
          rx="10"
          fill="#47365f"
          stroke="#b89ad9"
          strokeOpacity=".6"
        />
        <path
          d="M27 28h11m5 0h11m5 0h11"
          stroke="#c7a9e7"
          strokeWidth="3"
          strokeLinecap="round"
          opacity=".6"
        />
      </g>
      <g transform="rotate(8 80 58)">
        <rect
          x="37"
          y="31"
          width="88"
          height="57"
          rx="10"
          fill={`url(#${gradient})`}
          stroke="#e5d7ff"
          strokeOpacity=".5"
        />
        <path d="m73 47 19 12-19 12Z" fill="#fff" />
        <path
          d="M47 79h10m5 0h5"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          opacity=".5"
        />
      </g>
      <path d="m125 7 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#dfbc7f" />
      <circle cx="14" cy="72" r="3" fill="#bca5e7" opacity=".6" />
      <path
        d="M8 44h6m-3-3v6"
        stroke="#bca5e7"
        strokeLinecap="round"
        opacity=".5"
      />
    </svg>
  );
}

export function LibraryArtwork() {
  return (
    <svg
      className="library-art"
      viewBox="0 0 88 72"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="23"
        y="8"
        width="49"
        height="40"
        rx="7"
        transform="rotate(12 47 28)"
        fill="var(--panel-alt)"
        stroke="var(--accent-border)"
      />
      <rect
        x="12"
        y="22"
        width="56"
        height="40"
        rx="7"
        fill="var(--badge-background)"
        stroke="var(--accent-border)"
      />
      <path
        d="m19 52 12-12 10 9 8-8 12 11"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="51" cy="33" r="4" fill="var(--accent)" opacity=".55" />
      <path
        d="M72 54h10m-5-5v10"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="10" cy="12" r="2" fill="var(--accent)" opacity=".4" />
    </svg>
  );
}

export function CanvasArtwork() {
  return (
    <svg
      className="canvas-art"
      viewBox="0 0 108 70"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="10"
        y="8"
        width="88"
        height="52"
        rx="7"
        fill="var(--badge-background)"
        stroke="var(--accent-border)"
      />
      <rect
        x="20"
        y="17"
        width="68"
        height="34"
        rx="2"
        fill="none"
        stroke="var(--accent-border)"
        strokeDasharray="3 3"
      />
      <path d="M54 17v34M20 34h68" stroke="var(--accent-border)" opacity=".4" />
      <path
        d="M7 15V5h10m74 0h10v10M7 53v10h10m74 0h10V53"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="54" cy="34" r="3" fill="var(--accent)" opacity=".7" />
    </svg>
  );
}
