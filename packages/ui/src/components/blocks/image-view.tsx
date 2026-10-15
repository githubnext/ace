import { type CSSProperties, type ReactNode, useState } from "react";

import { IconCopy, IconExpand } from "../../icons";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "../../ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog";
import { cell, DEFAULT_H, DEFAULT_W, GRID_GAP, type Item, type Picture } from "./image-layout";

function ImageView(
	{ src, w, h, alt, width, fit: objectFit = "cover" }: {
		src: string;
		w: number;
		h: number;
		alt: string;
		width: number;
		fit?: "cover" | "contain";
	},
) {
	let scale = Math.min(1, width / w);
	let fit = Math.round(w * scale);
	let height = Math.round(h * scale);

	if (!src) {
		return (
			<div
				className="rounded-lg squircle flex items-end p-3 contain-strict shadow-[inset_0_0_0_1px_rgb(0_0_0/0.14)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
				style={{
					inlineSize: fit,
					maxInlineSize: "100%",
					blockSize: height,
					background: "linear-gradient(135deg, var(--color-muted) 0%, var(--color-border) 100%)",
				}}
			>
				<span className="text-xs text-muted-foreground">{alt} ({w}×{h})</span>
			</div>
		);
	}

	return (
		<ImageOpen
			src={src}
			alt={alt}
			style={{ inlineSize: fit, maxInlineSize: "100%", blockSize: height, contain: "strict" }}
		>
			<img
				src={src}
				alt={alt}
				className="size-full rounded-lg squircle shadow-[inset_0_0_0_1px_rgb(0_0_0/0.14)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
				style={{ objectFit }}
			/>
		</ImageOpen>
	);
}

function ImageGrid(
	{ count, height, items, scale, width }: {
		count: number;
		height: number;
		items: Item[];
		scale: number;
		width: number;
	},
) {
	let size = cell(width, scale);

	return (
		<div
			className="grid overflow-hidden contain-content"
			style={{
				blockSize: height,
				gap: GRID_GAP,
				gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
			}}
		>
			{items.map((item) => (
				<GridImage
					key={item.key}
					image={item.image}
					height={size}
					index={item.index}
					span={count === 3 && item.index === 2}
				/>
			))}
		</div>
	);
}

function GridImage(
	{ image, height, index, span }: {
		image: Picture;
		height: number;
		index: number;
		span?: boolean;
	},
) {
	let w = image.width || DEFAULT_W;
	let h = image.height || DEFAULT_H;
	let alt = image.alt || "";

	if (!image.src) {
		return (
			<div
				className="rounded-lg squircle flex items-end p-3 bg-muted shadow-[inset_0_0_0_1px_rgb(0_0_0/0.14)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
				data-index={index}
				style={{
					blockSize: height,
					gridColumn: span ? "span 2" : undefined,
				}}
			>
				<span className="text-xs text-muted-foreground">{alt} ({w}×{h})</span>
			</div>
		);
	}

	return (
		<ImageOpen
			src={image.src}
			alt={alt}
			style={{ blockSize: height, gridColumn: span ? "span 2" : undefined }}
		>
			<img
				src={image.src}
				alt={alt}
				data-index={index}
				className="rounded-lg squircle size-full object-cover shadow-[inset_0_0_0_1px_rgb(0_0_0/0.14)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
			/>
		</ImageOpen>
	);
}

/**
 * Opens a timeline image at full size. The context menu replaces the webview's own, whose "Open
 * Image in New Window" has no window to open.
 */
function ImageOpen(
	{ src, alt, style, children }: {
		src: string;
		alt: string;
		style: CSSProperties;
		children: ReactNode;
	},
) {
	let [open, setOpen] = useState(false);
	let [actual, setActual] = useState(false);
	let show = () => {
		setActual(false);
		setOpen(true);
	};

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger
					render={<button type="button" aria-label={`Open ${alt || "image"}`} />}
					className="block w-full cursor-zoom-in rounded-lg squircle"
					style={style}
					onClick={show}
				>
					{children}
				</ContextMenuTrigger>
				<ContextMenuContent className="w-36">
					<ContextMenuItem onClick={show}>
						<IconExpand />
						Open Image
					</ContextMenuItem>
					{/* Only inline images can be read back without the source's CORS consent. */}
					{src.startsWith("data:") && (
						<ContextMenuItem onClick={() => copy(src)}>
							<IconCopy />
							Copy Image
						</ContextMenuItem>
					)}
				</ContextMenuContent>
			</ContextMenu>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="top-4 w-fit max-w-[calc(100vw-2rem)] p-0 [--dialog-top:1rem] sm:max-w-[calc(100vw-2rem)]">
					<DialogTitle className="sr-only">{alt || "Image"}</DialogTitle>
					<img
						src={src}
						alt={alt}
						className={actual
							? "max-w-none cursor-zoom-out"
							: "max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] cursor-zoom-in"}
						onClick={() => setActual(!actual)}
					/>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** Safari's clipboard only takes PNG images. */
function copy(src: string) {
	void navigator.clipboard.write([new ClipboardItem({ "image/png": png(src) })]);
}

async function png(src: string): Promise<Blob> {
	let bitmap = await createImageBitmap(await (await fetch(src)).blob());
	let canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
	bitmap.close();
	return canvas.convertToBlob({ type: "image/png" });
}

export { ImageGrid, ImageView };
