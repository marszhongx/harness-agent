/**
 * The app mark, drawn as vectors so it stays crisp at any size: the same tile
 * and brackets as `assets/icon.svg` (824 grid, 560×560 mark), without Apple's
 * outer padding — inside the window the tile itself is the logo.
 */
export default function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 824 824" aria-hidden="true" focusable="false">
      <rect width="824" height="824" rx="185" fill="hsl(var(--primary-color))" />
      <g fill="none" stroke="#fff" strokeWidth="88" strokeLinecap="round" strokeLinejoin="round">
        <path d="M290 176H176v472h114" />
        <path d="M534 176h114v472H534" />
        <path d="M420 312l100 100-100 100" />
      </g>
    </svg>
  );
}
