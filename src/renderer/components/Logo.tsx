/**
 * The app mark, drawn as vectors so it stays crisp at any size: the same tile
 * and brackets as `assets/icon.svg`, without Apple's outer padding (inside the
 * window the tile itself is the logo).
 */
export default function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      <rect width="1024" height="1024" rx="228" fill="hsl(var(--primary-color))" />
      <g
        transform="translate(512 512) scale(0.86) translate(-512 -512)"
        fill="none"
        stroke="#fff"
        strokeWidth="86"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M404 268h-92a20 20 0 0 0-20 20v448a20 20 0 0 0 20 20h92" />
        <path d="M620 268h92a20 20 0 0 1 20 20v448a20 20 0 0 1-20 20h-92" />
        <path d="M466 428l84 84-84 84" />
      </g>
    </svg>
  );
}
