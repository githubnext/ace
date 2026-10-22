import { type ComponentPropsWithRef, useEffect, useRef, useState } from "react";
import { animate, m as motion, useMotionValue, useTransform } from "motion/react";
import { cn } from "../../lib/utils";

import { ComposerActions } from "./composer-actions";
import { ComposerSubmit } from "./composer-submit";
import { IconArrowDownToLineMicro } from "../../icons";
import "./composer.css";

type DivProps = ComponentPropsWithRef<"div">;

type AttachmentsProps = DivProps & {
	/** Whether the tray is visible above the composer. */
	open?: boolean;
};

/** Top attachments row above the composer header. */
function Attachments({ className, children, open = false, ref }: AttachmentsProps) {
	return (
		<div
			ref={ref}
			data-open={open || undefined}
			inert={open ? undefined : true}
			className={cn(
				"composer:attachments group/tray pointer-events-none absolute inset-x-0 top-0 flex -translate-y-full items-end px-4 opacity-0 transition-opacity duration-150 ease-out contain-layout contain-style *:pointer-events-auto data-[open]:opacity-100",
				className,
			)}
		>
			<div className="relative w-full translate-y-[80%] p-2 transition-transform duration-200 ease-out group-data-[open]/tray:translate-y-[40%] group-data-[open]/tray:hover:translate-y-[20%] hover:delay-150 after:absolute after:inset-x-0 after:bottom-0 after:h-3/4 after:rounded-t-lg after:squircle after:bg-muted after:shadow-composer-tray">
				{children}
			</div>
		</div>
	);
}

/** Left-aligned toolbar section. */
function Start({ className, ref, ...props }: DivProps) {
	return (
		<div
			ref={ref}
			className={cn("flex items-center", className)}
			{...props}
		/>
	);
}

/** Right-aligned toolbar section. */
function End({ className, ref, ...props }: DivProps) {
	return (
		<div
			ref={ref}
			className={cn("flex items-center gap-1", className)}
			{...props}
		/>
	);
}

/** Main input area between the header and footer rows. */
function Input({ className, ref, ...props }: DivProps) {
	return (
		<div
			ref={ref}
			className={cn("composer:input contain-content", className)}
			data-slot="input"
			{...props}
		/>
	);
}

/** Bottom footer row for actions, model selector, and send. */
function Footer({ className, ref, ...props }: DivProps) {
	return (
		<div
			ref={ref}
			className={cn(
				"composer:footer flex items-center justify-between gap-2 px-1.5 pb-1.5",
				className,
			)}
			{...props}
		/>
	);
}

type HeaderProps = DivProps & {
	/** Whether the header is expanded. */
	open?: boolean;
};

const HEADER_HEIGHT = 35;

/** Top bar below attachments for file count, mode badge, and metadata. */
function Header({ className, ref, open = true, children, ...props }: HeaderProps) {
	return (
		<div
			ref={ref}
			className="composer:header relative overflow-hidden bg-muted/50 transition-[height] duration-100 ease-out  contain-strict"
			style={{ height: open ? HEADER_HEIGHT : 0 }}
			inert={open ? undefined : true}
			{...props}
		>
			<div
				aria-hidden
				className={cn(
					"pointer-events-none absolute inset-x-0 bottom-0 z-10 h-px bg-border transition-opacity duration-[45ms] ease-out motion-reduce:transition-none",
					open ? "opacity-100" : "opacity-0",
				)}
			/>
			<div
				className={cn(
					"flex items-center justify-between px-1.5 py-1 transition-opacity duration-75 contain-content",
					open ? "opacity-100" : "opacity-0",
					className,
				)}
				style={{ minHeight: HEADER_HEIGHT }}
			>
				{children}
			</div>
		</div>
	);
}

type BodyProps = DivProps & {
	/** Called when files are dropped onto the composer body. */
	onFiles?: (files: File[]) => void;
};

/** Bordered wrapper grouping Header, Input, and Footer with drag-and-drop. */
function Body({ className, ref, onFiles, children, ...props }: BodyProps) {
	let [dragging, setDragging] = useState(false);
	let [hovering, setHovering] = useState(false);
	let global = useRef(0);
	let local = useRef(0);

	useEffect(() => {
		function enter(e: DragEvent) {
			e.preventDefault();
			if (!onFiles) return;
			if (++global.current === 1) setDragging(true);
		}
		function leave(e: DragEvent) {
			e.preventDefault();
			if (!onFiles) return;
			if (--global.current === 0) setDragging(false);
		}
		function over(e: DragEvent) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = onFiles ? "copy" : "none";
		}
		function drop(e: DragEvent) {
			e.preventDefault();
			global.current = 0;
			local.current = 0;
			setDragging(false);
			setHovering(false);
			if (!onFiles) return;
			let files = Array.from(e.dataTransfer?.files || []);
			if (files.length) onFiles(files);
		}

		document.addEventListener("dragenter", enter);
		document.addEventListener("dragleave", leave);
		document.addEventListener("dragover", over);
		document.addEventListener("drop", drop);
		return () => {
			document.removeEventListener("dragenter", enter);
			document.removeEventListener("dragleave", leave);
			document.removeEventListener("dragover", over);
			document.removeEventListener("drop", drop);
			global.current = 0;
			local.current = 0;
			setDragging(false);
			setHovering(false);
		};
	}, [onFiles]);

	return (
		<>
			<div
				ref={ref}
				className={cn(
					"composer:body relative z-10 min-w-0 overflow-clip rounded-xl squircle bg-background shadow-composer [grid-area:composer]",
					className,
				)}
				data-dragging={dragging || undefined}
				onDragEnter={(e) => {
					e.preventDefault();
					if (!onFiles) return;
					if (++local.current === 1) setHovering(true);
				}}
				onDragLeave={(e) => {
					e.preventDefault();
					if (!onFiles) return;
					if (--local.current === 0) setHovering(false);
				}}
				{...props}
			>
				{children}
				{dragging && (
					<div className="absolute inset-0 z-50 flex items-center justify-center gap-2 bg-background/80 text-sm text-muted-foreground backdrop-blur-sm">
						<IconArrowDownToLineMicro className="size-4" />
						Drop your files here.
					</div>
				)}
			</div>
			{dragging && (
				<div
					className={cn(
						"composer:glow-border z-20 text-accent transition-opacity duration-300 [grid-area:composer]",
						hovering ? "opacity-50" : "opacity-0",
					)}
				/>
			)}
		</>
	);
}

type GlowProps = {
	/** AnalyserNode for mic-reactive pulsing. */
	analyser?: AnalyserNode | null;
	/** Whether the glow is active (e.g. recording). */
	active?: boolean;
};

/** Mic-reactive recording glow behind the composer body. */
function Glow({ analyser = null, active = false }: GlowProps) {
	let raw = useMotionValue(0);
	let glow = useMotionValue(0);

	useEffect(() => {
		let controls = animate(glow, active ? 1 : 0, { duration: 0.3 });
		return () => controls.stop();
	}, [active, glow]);

	useEffect(() => {
		if (!analyser) return;
		raw.set(0);
		let data = new Uint8Array(analyser.frequencyBinCount);
		let raf = 0;
		function tick() {
			analyser!.getByteFrequencyData(data);
			let sum = 0;
			for (let i = 0; i < data.length; i++) sum += data[i];
			raw.set(Math.min(1, sum / data.length / 255 * 3));
			raf = requestAnimationFrame(tick);
		}
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [analyser, raw]);

	let o1 = useTransform([glow, raw], ([a, l]: number[]) => a * (0.1 + l * 0.6));
	let s1 = useTransform([glow, raw], ([a, l]: number[]) => 0.97 + a * (0.03 + l * 0.02));
	let o2 = useTransform([glow, raw], ([a, l]: number[]) => a * (0.08 + l * 0.7));
	let o3 = useTransform([glow, raw], ([a, l]: number[]) => a * (0.06 + l * 0.5));
	let s3 = useTransform([glow, raw], ([a, l]: number[]) => 1 + a * l * 0.015);

	return (
		<>
			<motion.div
				className="pointer-events-none z-0 rounded-2xl squircle bg-red-500/10 blur-xl [grid-area:composer]"
				style={{ opacity: o1, scale: s1 }}
			/>
			<motion.div
				className="pointer-events-none z-0 rounded-2xl squircle bg-rose-400/15 blur-lg [grid-area:composer]"
				style={{ opacity: o2 }}
			/>
			<motion.div
				className="pointer-events-none z-0 rounded-2xl squircle bg-orange-500/8 blur-xl [grid-area:composer]"
				style={{ opacity: o3, scale: s3 }}
			/>
		</>
	);
}

/** Chat message composer with text input and actions. */
function Root({ className, ref, ...props }: DivProps) {
	return (
		<div
			ref={ref}
			className={cn(
				"composer:root grid [grid-template-areas:'composer'] contain-layout contain-style",
				className,
			)}
			{...props}
		/>
	);
}

/** Chat message composer with header, input area, and toolbar. */
export const Composer: typeof Root & {
	Actions: typeof ComposerActions;
	Attachments: typeof Attachments;
	Body: typeof Body;
	Glow: typeof Glow;
	Header: typeof Header;
	Input: typeof Input;
	Footer: typeof Footer;
	Start: typeof Start;
	End: typeof End;
	Submit: typeof ComposerSubmit;
} = Object.assign(Root, {
	Actions: ComposerActions,
	Attachments,
	Body,
	Glow,
	Header,
	Input,
	Footer,
	Start,
	End,
	Submit: ComposerSubmit,
});
