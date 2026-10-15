import { submitState } from "./submit-state";
import { type ComponentPropsWithRef, useState } from "react";
import { AnimatePresence, m as motion } from "motion/react";

import { cn } from "../../lib/utils";
import {
	IconCheckMicro,
	IconListTodoMicro,
	IconLoader,
	IconMicMicro,
	IconSendMicro,
	IconStopFilledMicro,
} from "../../icons";

const EASE_IN: [number, number, number, number] = [0.55, 0, 0.85, 0.2];

const NONE = { initial: {}, animate: {}, exit: {} } as const;

const SLIDE = {
	initial: { y: "120%", opacity: 0 },
	animate: {
		y: 0,
		opacity: 1,
		transition: {
			y: { type: "spring", stiffness: 520, damping: 30, mass: 0.6, delay: 0.12 },
			opacity: { duration: 0.15, delay: 0.12 },
		},
	},
	exit: {
		y: "-120%",
		opacity: 0,
		transition: { duration: 0.22, ease: EASE_IN },
	},
} as const;

type SubmitProps = Omit<ComponentPropsWithRef<"button">, "children" | "onClick"> & {
	/** Whether the input is empty (controls mic vs send icon). */
	empty?: boolean;
	/** Whether the input is ready to submit. */
	ready?: boolean;
	/** Whether the composer is in recording mode. */
	recording?: boolean;
	/** Whether the composer is saving an edited message. */
	editing?: boolean;
	/** Whether submission is in progress. */
	busy?: boolean;
	/** The label while submission is in progress. */
	busyLabel?: string;
	/** Whether the composer is in plan mode (swaps paper plane for a checklist icon). */
	plan?: boolean;
	/** Called when the mic button is clicked to start recording. */
	onRecord?: () => void;
	/** Called when the stop button is clicked to stop recording. */
	onStop?: () => void;
	/** Called when the send button is clicked to submit. */
	onSend?: () => void;
};

const ICONS = {
	mic: IconMicMicro,
	send: IconSendMicro,
	plan: IconListTodoMicro,
	stop: IconStopFilledMicro,
	edit: IconCheckMicro,
	loading: IconLoader,
};

function SubmitIcon({ mode }: { mode: ReturnType<typeof submitState>["mode"] }) {
	let Icon = ICONS[mode];
	return (
		<Icon
			className={cn(mode === "stop" ? "size-3" : "size-4", mode === "loading" && "animate-spin")}
		/>
	);
}

/** Circular submit button that morphs between mic, send, plan, edit, and stop icons. The send (paper plane) icon slides up on click and the next icon rises in from below; other transitions swap instantly. */
function ComposerSubmit(
	{
		empty = true,
		ready = false,
		recording = false,
		editing = false,
		busy = false,
		busyLabel,
		plan = false,
		onRecord,
		onStop,
		onSend,
		className,
		disabled,
		ref,
		...props
	}: SubmitProps,
) {
	let [tick, setTick] = useState(0);
	let state = submitState({ busy, busyLabel, editing, empty, plan, recording });
	let { mode, label } = state;
	let variant = mode === "send" ? SLIDE : NONE;
	let off = disabled || state.disabled;
	function click() {
		if (state.disabled) return;
		if (mode === "mic") return onRecord?.();
		if (mode === "stop") return onStop?.();
		if (mode === "send") setTick(t => t + 1);
		onSend?.();
	}

	return (
		<button
			ref={ref}
			type="button"
			{...props}
			aria-label={label}
			disabled={off}
			className={cn(
				"relative flex size-7 items-center justify-center overflow-hidden rounded-full! contain-content active:scale-[0.96]",
				"transition-[background-color,color,box-shadow,scale] duration-150",
				mode === "stop"
					? "bg-red-500 text-white"
					: off
					? "bg-muted text-muted-foreground"
					: ready
					? "bg-primary text-primary-foreground"
					: "bg-foreground text-background",
				className,
			)}
			onClick={click}
		>
			<AnimatePresence mode="popLayout" initial={false}>
				<motion.span
					key={`${mode}-${tick}`}
					className="flex items-center justify-center"
					initial={variant.initial}
					animate={variant.animate}
					exit={variant.exit}
				>
					<SubmitIcon mode={mode} />
				</motion.span>
			</AnimatePresence>
		</button>
	);
}

export { ComposerSubmit, type SubmitProps };
