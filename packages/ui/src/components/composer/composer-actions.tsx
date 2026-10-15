import { type ComponentPropsWithRef, type ReactNode, useState } from "react";
import {
	AnimatePresence,
	m as motion,
	useIsPresent,
	useMotionValue,
	useTransform,
} from "motion/react";

import { cn } from "../../lib/utils";

type ActionsProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
	/** Primary action — always visible (e.g. Submit). */
	primary: ReactNode;
	/** Optional secondary action — sits behind primary, slides into a partial overlap, pulls to full reveal on hover or focus-within. */
	secondary?: ReactNode;
};

// Geometry of the overlapping primary (size-7) and secondary (size-6) buttons.
const PRIMARY = 28;
const SECONDARY = 24;
const GAP = 2; // gap-0.5
// Secondary fully hidden: shifted right by its own width plus the gap so its
// right edge lands exactly at primary's left edge.
const HIDDEN = SECONDARY + GAP;
// Resting peek (px) — secondary sticks out from behind primary by this much.
const OVERLAP = 10;
// Notch radius carved out of the secondary: primary's radius plus the gap.
const RADIUS = PRIMARY / 2 + GAP;
// Notch center along the secondary at x=0, measured from its left edge. The
// secondary translates by x, so the center shifts to (CENTER - x) to stay
// pinned to the fixed primary.
const CENTER = SECONDARY + GAP + PRIMARY / 2;

/**
 * Secondary action. Slides out from behind the primary while carrying a
 * circular notch that tracks the primary's edge, so a clean transparent gap
 * follows the primary (revealing whatever sits behind, including the ace glow)
 * without a background-colored masking border on the primary.
 */
function Secondary({ revealed, children }: { revealed: boolean; children: ReactNode }) {
	// WebKit pauses animation frames in a hidden window, so an exit can outlast the action it
	// offered, such as Stop after a run ends; a leaving action must stop being one at once.
	let present = useIsPresent();
	let x = useMotionValue(HIDDEN);
	let mask = useTransform(
		x,
		v =>
			`radial-gradient(circle ${RADIUS}px at ${CENTER - v}px 50%, transparent ${
				RADIUS - 1
			}px, #000 ${RADIUS}px)`,
	);
	return (
		<motion.span
			className="flex"
			inert={!present}
			style={{
				x,
				maskImage: mask,
				maskRepeat: "no-repeat",
				WebkitMaskImage: mask,
				WebkitMaskRepeat: "no-repeat",
			}}
			initial={{ x: HIDDEN }}
			animate={{ x: revealed ? 0 : OVERLAP }}
			exit={{ x: HIDDEN }}
			transition={{ type: "spring", stiffness: 380, damping: 32 }}
		>
			{children}
		</motion.span>
	);
}

/**
 * Composer action buttons row. Renders a required primary action (typically
 * Submit) with an optional secondary action (Stop, Cancel) to its left. The
 * secondary cycles through three positions:
 *   - hidden  (mount / unmount): fully behind primary
 *   - resting (default visible): peeks out by {@link OVERLAP}px
 *   - revealed (hover / focus-within): no overlap, fully separated
 *
 * The container's hit area is expanded with negative-margin padding so the
 * reveal fires when the cursor is near, not only directly on top.
 */
function ComposerActions({
	primary,
	secondary,
	className,
	ref,
	onMouseEnter,
	onMouseLeave,
	onFocus,
	onBlur,
	...props
}: ActionsProps) {
	let [hover, setHover] = useState(false);
	let [focus, setFocus] = useState(false);
	let revealed = hover || focus;
	return (
		<div
			ref={ref}
			className={cn(
				"group/actions relative isolate flex shrink-0 items-center gap-0.5",
				// 22px invisible halo for early hover detection; negative margin keeps layout slot stable.
				"p-[22px] -m-[22px]",
				className,
			)}
			onMouseEnter={e => {
				setHover(true);
				onMouseEnter?.(e);
			}}
			onMouseLeave={e => {
				setHover(false);
				onMouseLeave?.(e);
			}}
			onFocus={e => {
				setFocus(true);
				onFocus?.(e);
			}}
			onBlur={e => {
				// Ignore focus shuffling between primary and secondary to avoid flicker.
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocus(false);
				onBlur?.(e);
			}}
			{...props}
		>
			<AnimatePresence initial={false}>
				{secondary && (
					<Secondary key="secondary" revealed={revealed}>
						{secondary}
					</Secondary>
				)}
			</AnimatePresence>
			{primary}
		</div>
	);
}

export { ComposerActions };
