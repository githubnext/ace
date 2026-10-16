import type { ComponentPropsWithRef } from "react";
import { AnimatePresence, m as motion } from "motion/react";
import { cn } from "../../lib/utils";

type DivProps = ComponentPropsWithRef<"div">;

type Attachment = {
	/** Unique identifier. */
	id: string;
	/** Display name. */
	name: string;
	/** MIME type. */
	type: string;
	/** File size in bytes. */
	size?: number;
	/** Preview URL for images/videos. */
	preview?: string;
	/** The added file, for reading contents that have no preview. */
	file?: File;
};

const ROTATIONS = [-2, 1.5, -1, 2, -1.5];
const EDGE =
	"pointer-events-none absolute inset-0 rounded-[inherit] squircle shadow-[inset_0_0_0_1px_rgb(0_0_0/0.18)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]";

const item = {
	hidden: { opacity: 0, scale: 0.9, y: 15, rotate: 0 },
	visible: (i: number) => ({
		opacity: 1,
		scale: 1,
		y: 0,
		rotate: ROTATIONS[i % ROTATIONS.length],
		transition: {
			type: "spring" as const,
			stiffness: 500,
			damping: 25,
			delay: 0.1 + i * 0.05,
			rotate: { type: "spring" as const, stiffness: 500, damping: 25 },
		},
	}),
	exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15 } },
};

/** Individual attachment preview card. */
function Item(
	{ attachment, index, onRemove }: {
		attachment: Attachment;
		index: number;
		onRemove?: (id: string) => void;
	},
) {
	let image = attachment.type.startsWith("image/");
	let video = attachment.type.startsWith("video/");
	let media = (image || video) && attachment.preview;

	return (
		<motion.div
			layout
			custom={index}
			variants={item}
			initial="hidden"
			animate="visible"
			exit="exit"
			transition={{ layout: { type: "spring", stiffness: 500, damping: 30 } }}
			whileHover={{ rotate: 0, transition: { duration: 0.15 } }}
			className={cn(
				"group relative flex shrink-0 flex-col rounded-lg squircle contain-content",
				media
					? "bg-transparent"
					: "bg-muted shadow-surface",
			)}
		>
			{image && attachment.preview && (
				<div className="relative size-16 overflow-hidden rounded-[inherit] squircle bg-black">
					<img
						src={attachment.preview}
						alt={attachment.name}
						className="block size-full object-cover"
					/>
					<span className={EDGE} />
				</div>
			)}
			{video && attachment.preview && (
				<div className="relative size-16 overflow-hidden rounded-[inherit] squircle bg-black">
					<video
						src={attachment.preview}
						className="block size-full object-cover"
						muted
					/>
					<span className={EDGE} />
				</div>
			)}
			{!image && !video && (
				<div className="flex size-16 items-center justify-center text-xs text-muted-foreground">
					{extension(attachment.name)}
				</div>
			)}
			{onRemove && (
				<button
					type="button"
					aria-label="Remove attachment"
					onClick={() => onRemove(attachment.id)}
					className="absolute top-0 right-0 flex size-10 items-start justify-end p-0.5 outline-2 outline-offset-[-1px] outline-transparent focus-visible:outline-ring/50 notouch:opacity-0 notouch:transition-opacity notouch:duration-75 notouch:group-hover:opacity-100 notouch:focus-visible:opacity-100"
				>
					<span className="flex size-5 items-center justify-center rounded-md squircle bg-foreground/70 text-xs text-background">
						&times;
					</span>
				</button>
			)}
		</motion.div>
	);
}

function extension(name: string) {
	let dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot) : name;
}

/** Horizontally scrollable list of attachment previews with scroll fade. */
function AttachmentList({
	attachments,
	onRemove,
	className,
	ref,
	...props
}: DivProps & {
	attachments: Attachment[];
	onRemove?: (id: string) => void;
}) {
	if (!attachments.length) return null;

	return (
		<div
			ref={ref}
			data-axis="x"
			className={cn("scroll-fade contain-paint relative z-10 flex gap-2 px-1 py-1", className)}
			{...props}
		>
			<AnimatePresence mode="popLayout">
				{attachments.map((a, i) => (
					<Item
						key={a.id}
						attachment={a}
						index={i}
						onRemove={onRemove}
					/>
				))}
			</AnimatePresence>
		</div>
	);
}

export { type Attachment, AttachmentList };
