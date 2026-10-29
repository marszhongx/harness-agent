import type { HTMLAttributes, ReactNode } from "react";
import ui from "../styles/ui.module.css";

export type TagTone = "default" | "ok" | "warn" | "error";

type TagProps = {
  tone?: TagTone;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "children">;

const TONE_CLASS: Record<TagTone, string> = {
  default: "",
  ok: ui.ok,
  warn: ui.warn,
  error: ui.error,
};

/** The one pill for counts, scope labels, and status marks. */
export default function Tag({ tone = "default", className, children, ...rest }: TagProps) {
  const classes = [ui.badge, TONE_CLASS[tone], className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}
