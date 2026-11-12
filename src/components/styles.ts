// Shared Tailwind class sets so every screen uses one radius, spacing, and
// contrast scale.
//
// Radius: page surfaces rounded-2xl, inset cards rounded-xl, controls
// rounded-lg, rows inside an inset list rounded-md.
// Size: controls keep their label at roughly 40% of their height, so text
// reads clearly without the control growing (lg 44px/16px, md 40px/15px,
// sm 32px/14px).
// Contrast: text stays at WCAG AA (4.5:1) and input borders at 3:1 against the
// dark surfaces they sit on.

const focusRingClasses =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300";

export const surfaceClasses =
  "rounded-2xl border border-white/10 bg-slate-900/70 shadow-xl shadow-black/25 backdrop-blur-sm";

export const insetClasses = "rounded-xl border border-white/10 bg-slate-950/40";

export const headingClasses =
  "text-2xl font-semibold tracking-tight text-white";

export const mutedTextClasses = "text-sm leading-6 text-pretty text-slate-400";

export const centeredCardBodyClasses =
  "mt-4 text-sm leading-7 text-slate-300 sm:text-base";

export const fieldLabelClasses =
  "mb-2 block text-sm font-semibold text-slate-200";

export const inputClasses =
  "h-10 w-full min-w-0 rounded-lg border border-slate-500 bg-slate-950/70 px-3.5 font-mono text-sm text-slate-100 transition outline-none placeholder:font-sans placeholder:text-slate-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30";

const buttonBaseClasses = `inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition enabled:active:translate-y-px disabled:cursor-not-allowed disabled:border-transparent disabled:bg-slate-800 disabled:text-slate-400 ${focusRingClasses}`;

const buttonSizeClasses = {
  lg: "h-11 px-6 text-base",
  md: "h-10 px-4 text-[15px]",
  sm: "h-8 px-3 text-sm",
  icon: "size-9 text-sm",
} as const;

const buttonVariantClasses = {
  primary: "bg-cyan-400 text-slate-950 hover:bg-cyan-300",
  secondary:
    "border border-white/15 bg-white/10 text-slate-100 hover:border-white/25 hover:bg-white/15",
  warning: "bg-amber-400 text-slate-950 hover:bg-amber-300",
  danger:
    "border border-rose-400/40 bg-rose-500/15 text-rose-100 hover:border-rose-300/60 hover:bg-rose-500/25",
} as const;

export function buttonClasses(
  variant: keyof typeof buttonVariantClasses,
  size: keyof typeof buttonSizeClasses = "md",
): string {
  return `${buttonBaseClasses} ${buttonSizeClasses[size]} ${buttonVariantClasses[variant]}`;
}

export const radioClasses = `size-4 shrink-0 accent-cyan-400 ${focusRingClasses}`;
