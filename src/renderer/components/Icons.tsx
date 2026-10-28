/**
 * The app's icon set: one 24-unit grid, one stroke weight, one set of joins.
 *
 * Every glyph is drawn with the same `base` props so they cannot drift apart —
 * before this file, the UI mixed stroke widths from 1.5 to 2.6 and sizes from
 * 10 to 18. Sizes are 16 for controls and 14 where an icon sits inside a chip.
 * Corners are square (90°, which is on Alipay's 30° grid); caps and joins are
 * round so the ends read soft at 16px.
 */
import type { ReactNode } from "react";

const base = {
  "aria-hidden": true,
  focusable: "false",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

interface IconProps {
  size?: number;
}

function glyph(children: ReactNode) {
  return ({ size = 16 }: IconProps) => (
    <svg {...base} width={size} height={size}>
      {children}
    </svg>
  );
}

export const PlusIcon = glyph(<path d="M12 5v14M5 12h14" />);

export const ModelsIcon = glyph(
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
  </>,
);

/** Six rays 60° apart: a spark, and every direction on the 30° grid. */
export const SkillsIcon = glyph(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M17.5 15.2 20.5 16.9M12 18.4V21.8M6.5 15.2 3.5 16.9M6.5 8.8 3.5 7.1M12 5.6V2.2M17.5 8.8 20.5 7.1" />
  </>,
);

export const AgentsIcon = glyph(
  <>
    <rect x="4" y="7" width="16" height="12" rx="2" />
    <path d="M12 7V4M9 13v.01M15 13v.01" />
  </>,
);

export const ScheduleIcon = glyph(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4l3.5 2" />
  </>,
);

/** Settings: three sliders — a gear turns to mush at 16px, this stays legible. */
export const SettingsIcon = glyph(
  <>
    <path d="M4 7h16M4 12h16M4 17h16" />
    <circle cx="9" cy="7" r="2" />
    <circle cx="15" cy="12" r="2" />
    <circle cx="8" cy="17" r="2" />
  </>,
);

export const HistoryIcon = glyph(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v4.5h4.5" />
    <path d="M12 8v4.3l3 1.8" />
  </>,
);

/** Collapse / expand the sidebar: a pane split. */
export const PanelIcon = glyph(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
  </>,
);

/** Reload: a circular arrow whose head corners are 90°, on the 30° grid. */
export const RefreshIcon = glyph(
  <>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
    <path d="M20.5 3.5v5.5H15" />
  </>,
);

export const FolderIcon = glyph(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
);

export const ChevronDownIcon = glyph(<path d="m6 9 6 6 6-6" />);
export const ChevronRightIcon = glyph(<path d="m9 18 6-6-6-6" />);

export const PaperclipIcon = glyph(
  <path d="M21 12.5 12.5 21a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />,
);

export const SendIcon = glyph(<path d="M5 12h14M13 6l6 6-6 6" />);

export const TrashIcon = glyph(
  <>
    <path d="M4 7h16" />
    <path d="M10 4h4" />
    <path d="M6.5 7l.8 12a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1L17.5 7" />
    <path d="M10 11v5M14 11v5" />
  </>,
);

export const InfoIcon = glyph(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5" />
    <path d="M12 7.6v.6" />
  </>,
);

export const CloseIcon = glyph(<path d="M6 6l12 12M18 6L6 18" />);

/** A dialog's warning mark: a triangle with square corners. */
export const WarningIcon = glyph(
  <>
    <path d="M12 4 2.5 20h19L12 4z" />
    <path d="M12 10v4.5M12 17.4v.01" />
  </>,
);

/**
 * Thinking level: a brain. The two lobes are one path mirrored, plus the fold in
 * the middle; drawn on a 4-unit grid (Lucide's brain, ISC) so it stays upright
 * and readable at 16px instead of turning into a wide blob.
 */
const brainHalf = <path d="M12 5a3 3 0 1 0-6 .1 4 4 0 0 0-2.5 5.8 4 4 0 0 0 .5 6.6A4 4 0 0 0 12 18z" />;

export const ThinkingIcon = glyph(
  <>
    {brainHalf}
    <g transform="scale(-1 1) translate(-24 0)">{brainHalf}</g>
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
  </>,
);

export const ElectronIcon = glyph(
  <>
    <circle cx="12" cy="12" r="2.4" />
    <ellipse cx="12" cy="12" rx="9" ry="4" />
    <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)" />
  </>,
);

/** The Node hexagon, sized to the same 18-unit box as Electron's rings so the
 *  two sit level in a row. */
export const NodeIcon = glyph(<path d="M12 3.5l7.8 4.5v8L12 20.5l-7.8-4.5v-8z" />);

/** The stop button's mark: a filled square, not a stroke. */
export function StopIcon({ size = 14 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
    >
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  );
}
