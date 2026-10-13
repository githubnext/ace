import { type ComponentPropsWithoutRef, useEffect, useRef, useState } from "react";

import type { Block } from "../../lib/block";
import { cn } from "../../lib/utils";
import { code, diff, type Mention, text } from "../blocks";
import { fonts, parseSegments } from "../blocks/parse";

async function blocks(raw: string, mentions?: Mention[]): Promise<Block[]> {
	let parts = await parseSegments(raw, mentions, fonts());
	return parts.map(part => {
		if (part.kind === "text") return text(part.raw, mentions, false, false, part.blocks);
		if (part.kind === "diff") return diff(part.patch);
		return code(part.source, part.language, false, part.nodes);
	});
}

/** The draft as the timeline will show it once sent. */
function Preview(
	{ raw, mentions, className, ...props }: ComponentPropsWithoutRef<"div"> & {
		raw: string;
		mentions?: Mention[];
	},
) {
	let el = useRef<HTMLDivElement>(null);
	let [width, setWidth] = useState(0);
	let [parsed, setParsed] = useState<Block[]>([]);

	useEffect(() => {
		let active = true;
		void blocks(raw, mentions).then(next => active && setParsed(next));
		return () => {
			active = false;
		};
	}, [raw, mentions]);

	useEffect(() => {
		let node = el.current;
		if (!node) return;
		// Opening the preview moves focus here, so its shortcut can close it again.
		node.focus();
		let observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			ref={el}
			tabIndex={0}
			aria-label="Preview"
			className={cn("flex max-h-[300px] flex-col gap-1.5 overflow-y-auto p-3", className)}
			{...props}
		>
			{width > 0
				&& parsed.map((block, i) => (
					<div key={block.key ?? i} style={{ height: block.measure(width).height }}>
						{block.render(width)}
					</div>
				))}
			{!raw.trim() && <p className="text-muted-foreground">Nothing to preview</p>}
		</div>
	);
}

export { Preview };
