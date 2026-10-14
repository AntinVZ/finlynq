"use client";

/**
 * ActionButton — one button for every decision in the Merchants section
 * (P8 stage 5). The intent sets colour AND icon, and the label is required,
 * so the meaning never rests on colour alone:
 *
 *   confirm  green  ✓   accept, make canonical, add to the directory
 *   reject   red    ✕   reject, delete, undo
 *   open     blue   ↗   open a profile, a list, the transactions
 *   caution  amber  !   needs your decision / a risky change
 *   neutral  grey       anything secondary
 *
 * `danger` (reject / caution) shows `summary` — what will change — next to
 * the button and links it via aria-describedby. On touch screens every
 * button is at least 44 × 44 px. `iconOnly` hides the label visually but
 * keeps it as the accessible name and the tooltip.
 */

import { forwardRef, useId, type ComponentProps, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, Check, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ActionIntent = "confirm" | "reject" | "open" | "caution" | "neutral";

const STYLE: Record<ActionIntent, { solid: string; soft: string; icon: LucideIcon | null }> = {
  confirm: {
    solid: "bg-action-confirm text-action-confirm-foreground hover:bg-action-confirm/90",
    soft: "border-action-confirm-text/40 bg-transparent text-action-confirm-text hover:bg-action-confirm/10",
    icon: Check,
  },
  reject: {
    solid: "bg-action-reject text-action-reject-foreground hover:bg-action-reject/90",
    soft: "border-action-reject-text/40 bg-transparent text-action-reject-text hover:bg-action-reject/10",
    icon: X,
  },
  open: {
    solid: "bg-action-open text-action-open-foreground hover:bg-action-open/90",
    soft: "border-action-open-text/40 bg-transparent text-action-open-text hover:bg-action-open/10",
    icon: ArrowUpRight,
  },
  caution: {
    solid: "bg-action-caution text-action-caution-foreground hover:bg-action-caution/90",
    soft: "border-action-caution-text/50 bg-transparent text-action-caution-text hover:bg-action-caution/15",
    icon: AlertTriangle,
  },
  neutral: {
    solid: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
    soft: "border-border bg-transparent text-foreground hover:bg-muted",
    icon: null,
  },
};

/** Classes for a small coloured chip/badge in an intent's colour (no button). */
export function actionChipClass(intent: ActionIntent): string {
  return {
    confirm: "border-action-confirm-text/40 text-action-confirm-text",
    reject: "border-action-reject-text/40 text-action-reject-text",
    open: "border-action-open-text/40 text-action-open-text",
    caution: "border-action-caution-text/50 text-action-caution-text bg-action-caution/10",
    neutral: "border-border text-muted-foreground",
  }[intent];
}

export type ActionButtonProps = Omit<ComponentProps<typeof Button>, "variant" | "children"> & {
  intent: ActionIntent;
  /** The visible label (always required: no meaning by colour or icon alone). */
  children: ReactNode;
  /** Outline style for secondary placements (rows of a list). */
  soft?: boolean;
  /** Replace the intent's default icon; `null` = no icon. */
  icon?: LucideIcon | null;
  /** Only the icon is visible; the label stays the accessible name and tooltip. */
  iconOnly?: boolean;
  /** What will change (shown and read out for danger actions). */
  summary?: ReactNode;
  /** A keyboard hint shown on wide screens (e.g. "Enter"). */
  shortcut?: string;
};

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { intent, children, soft, icon, iconOnly, summary, shortcut, className, size = "sm", ...rest },
  ref,
) {
  const style = STYLE[intent];
  const Icon = icon === undefined ? style.icon : icon;
  const summaryId = useId();
  const label = typeof children === "string" ? children : undefined;
  const button = (
    <Button
      ref={ref}
      type="button"
      size={iconOnly ? "icon-sm" : size}
      data-intent={intent}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : rest.title}
      aria-describedby={summary ? summaryId : undefined}
      className={cn(
        "pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        soft ? cn("border", style.soft) : style.solid,
        className,
      )}
      {...rest}
    >
      {Icon && <Icon aria-hidden="true" />}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
      {shortcut && !iconOnly && (
        <kbd className="ms-1 hidden rounded border border-current/30 px-1 text-[10px] font-normal opacity-70 lg:inline">{shortcut}</kbd>
      )}
    </Button>
  );
  if (!summary) return button;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      {button}
      <span id={summaryId} className="text-xs text-muted-foreground">
        {summary}
      </span>
    </span>
  );
});
