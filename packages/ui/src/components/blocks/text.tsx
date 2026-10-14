import { type CSSProperties, Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { type LayoutCursor, prepareWithSegments } from "@chenglou/pretext";
import {
	measureRichInlineStats,
	type RichInlineItem,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";

import type { Block } from "../../lib/block";

import { INLINE_CODE_PADDING, LIST_INDENT, QUOTE_BORDER, QUOTE_INDENT } from "./constants";
import { image as imageBlock } from "./image";
import {
	type BlockNode,
	fallback,
	type FontConfig,
	fonts as blockFonts,
	type Line,
	type Mention,
	type TableCell,
	type TableRow,
} from "./parse";
import "./blocks.css";

const CELL_PAD_X = 8;
const CELL_PAD_Y = 5;
const TABLE_BORDER = 1;
const TABLE_WIDTH = 100000;
const BLOCK_GAP = 6;

function codeStyle(fonts: FontConfig): CSSProperties {
	return {
		paddingInline: INLINE_CODE_PADDING,
		borderRadius: "var(--radius-sm)",
		background: "var(--color-muted)",
		font: fonts.codeFont,
		lineHeight: `${fonts.lineHeight}px`,
		whiteSpace: "nowrap",
		// Pretext charges `extraWidth` to every line fragment of a wrapped item, so each fragment
		// draws its own padding.
		boxDecorationBreak: "clone",
		WebkitBoxDecorationBreak: "clone",
	};
}

function pieces(text: string): string[] {
	return text.match(/\S+\s*|\s+/g) || [];
}

type Track = {
	raw: string;
	edge: number;
	cursor: number;
	active: boolean;
};

function emojiStyle(fonts: FontConfig): CSSProperties {
	return {
		display: "inline-block",
		blockSize: `${fonts.emojiSize}px`,
		inlineSize: `${fonts.emojiSize}px`,
		verticalAlign: "text-bottom",
		objectFit: "contain",
	};
}

/** The full text of an unbreakable token, shown when it is truncated. */
function label(node: Line["nodes"][number]): string | undefined {
	switch (node.kind) {
		case "mention":
			return "@" + node.name;
		case "document":
			return node.name;
		case "plan":
			return "plan.md";
		case "emoji":
			return `:${node.name}:`;
	}
}

function avatarStyle(src: string): CSSProperties {
	return { backgroundImage: `url(${JSON.stringify(src)})` };
}

type ReferenceProps =
	| { kind: "document"; uid: string; name: string }
	| { kind: "plan"; prefix: boolean };

function LocalReference(props: ReferenceProps) {
	return (
		<button
			type="button"
			className="document-reference"
			data-document-uid={props.kind === "document" ? props.uid : undefined}
			data-document-name={props.kind === "document" ? props.name : undefined}
			data-plan-reference={props.kind === "plan" ? "" : undefined}
		>
			{(props.kind === "document" || props.prefix) && (
				<span className="document-reference-copy">&amp;</span>
			)}
			<span className="chip-name">{props.kind === "plan" ? "plan.md" : props.name}</span>
		</button>
	);
}

function inline(node: Line["nodes"][number], index: number): string {
	switch (node.kind) {
		case "mention":
			return `${index}:mention:${node.name}:${node.avatar || ""}`;
		case "document":
			return `${index}:document:${node.uid}:${node.name}:${node.reference}`;
		case "plan":
			return `${index}:plan:${node.reference}`;
		case "emoji":
			return `${index}:emoji:${node.name}:${node.src || ""}`;
		case "code":
		case "text":
			return `${index}:${node.kind}:${node.text}`;
		case "link":
			return `${index}:link:${node.href}:${node.text}`;
	}
}

function lineid(line: Line, index: number): string {
	let key = `${index}:line`;
	for (let i = 0; i < line.nodes.length; i++) key += ":" + inline(line.nodes[i]!, i);
	return key;
}

function nodeid(node: BlockNode, index: number): string {
	switch (node.kind) {
		case "paragraph":
		case "heading":
			return `${index}:${node.kind}:${node.lines.map(lineid).join("|")}`;
		case "list":
			return `${index}:list:${node.items.length}:${node.ordered ? "1" : "0"}`;
		case "blockquote":
			return `${index}:blockquote:${node.children.length}`;
		case "table":
			return `${index}:table:${node.rows.map(rowid).join("|")}`;
		case "image":
			return `${index}:image:${node.src}:${node.alt}`;
		case "hr":
			return `${index}:hr`;
	}
}

function itemid(item: BlockNode[], index: number): string {
	let key = `${index}:item`;
	for (let i = 0; i < item.length; i++) key += ":" + nodeid(item[i]!, i);
	return key;
}

function pathid(path: string, index: number): string {
	return `${path}.${index}`;
}

function cellid(cell: TableCell, index: number): string {
	return `${index}:cell:${cell.align || ""}:${cell.header ? "1" : "0"}:${
		cell.lines.map(lineid).join("|")
	}`;
}

function rowid(row: TableRow, index: number): string {
	return `${index}:row:${row.cells.map(cellid).join("|")}`;
}

function fresh(track: Track, text: string): boolean {
	if (!track.active) return false;
	if (!text.trim()) return false;
	let index = track.raw.indexOf(text, track.cursor);
	if (index < 0) index = track.cursor;
	track.cursor = index + text.length;
	return index >= track.edge;
}

/**
 * Source offsets, keyed by inline node index, where Pretext starts each wrapped line, and the
 * unbreakable nodes wider than the line.
 */
type Wraps = { breaks: Map<number, number[]>; wide: Set<number> };

/** An item's Pretext segments, where each starts, and the source offset of each laid-out char. */
type Source = { segments: string[]; starts: number[]; offsets: number[] };

const NO_WRAPS: Wraps = { breaks: new Map(), wide: new Set() };
const COLLAPSIBLE = /[ \t\n\f\r]/;
let wrapCache = new WeakMap<Line, { width: number; wraps: Wraps }>();
let sourceCache = new WeakMap<RichInlineItem, Source>();
let graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Pretext lays out each item's whitespace-collapsed text, which `prepareWithSegments` reproduces
 * segment for segment; map that text back onto the source once per item.
 */
function source(item: RichInlineItem): Source {
	let hit = sourceCache.get(item);
	if (hit) return hit;
	let { segments } = prepareWithSegments(item.text, item.font);
	let starts: number[] = [];
	let length = 0;
	for (let segment of segments) {
		starts.push(length);
		length += segment.length;
	}
	let text = item.text;
	let offsets: number[] = [];
	let at = 0;
	while (at < text.length && COLLAPSIBLE.test(text[at]!)) at++;
	for (let n = 0; n <= length; n++) {
		offsets.push(at);
		if (!COLLAPSIBLE.test(text[at] || "")) at++;
		else while (at < text.length && COLLAPSIBLE.test(text[at]!)) at++;
	}
	let value = { segments, starts, offsets };
	sourceCache.set(item, value);
	return value;
}

function sourceOffset(item: RichInlineItem, cursor: LayoutCursor): number {
	let { segments, starts, offsets } = source(item);
	let target = starts[cursor.segmentIndex]!;
	if (cursor.graphemeIndex > 0) {
		let n = 0;
		for (let { segment } of graphemes.segment(segments[cursor.segmentIndex]!)) {
			if (n++ === cursor.graphemeIndex) break;
			target += segment.length;
		}
	}
	return offsets[target]!;
}

/**
 * Where Pretext wraps `line` at `width`. The browser's own line breaker and text shaping disagree
 * with Pretext at some boundaries (`body/meta`, link text, subpixel drift), and the block height is
 * Pretext's, so rendering forces Pretext's breaks instead of letting the browser choose its own.
 */
function wrapsAt(line: Line, width: number): Wraps {
	if (!line.prepared) return NO_WRAPS;
	let hit = wrapCache.get(line);
	if (hit?.width === width) return hit.wraps;

	let wraps: Wraps = { breaks: new Map(), wide: new Set() };
	let first = true;
	walkRichInlineLineRanges(line.prepared, width, range => {
		if (range.width > width) {
			for (let fragment of range.fragments) {
				if (fragment.occupiedWidth > width) wraps.wide.add(fragment.itemIndex);
			}
		}
		if (first) {
			first = false;
			return;
		}
		let { itemIndex, start } = range.fragments[0]!;
		let at = sourceOffset(line.items[itemIndex]!, start);
		let list = wraps.breaks.get(itemIndex);
		if (list) list.push(at);
		else wraps.breaks.set(itemIndex, [at]);
	});
	wrapCache.set(line, { width, wraps });
	return wraps;
}

/** Wrap offsets inside an item, and whether its line also starts at the item. */
function within(item: RichInlineItem, offsets: number[] | undefined) {
	let lead = offsets?.[0] === source(item).offsets[0];
	return { lead, offsets: lead ? offsets?.slice(1) : offsets };
}

/** Split `text` at wrap offsets, joining the pieces with forced line breaks. */
function wrapText(text: string, offsets: number[] | undefined, key: string): ReactNode {
	if (!offsets) return text;
	let out: ReactNode[] = [];
	let last = 0;
	for (let at of offsets) {
		if (at > last) out.push(text.slice(last, at));
		out.push(<Wrap key={pathid(key, at)} />);
		last = at;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

/** A line break that is drawn but never copied, so selected text keeps its original spacing. */
function Wrap() {
	return <span className="line-wrap" aria-hidden />;
}

/** Measure height and widest line across `lines` in a single Pretext walk. */
function measureLines(
	lines: Line[],
	width: number,
	lineHeight: number,
): { height: number; fit: number } {
	let h = 0, f = 0;
	for (let line of lines) {
		if (!line.prepared) {
			h += lineHeight;
			continue;
		}
		let stats = measureRichInlineStats(line.prepared, width);
		h += Math.max(1, stats.lineCount) * lineHeight;
		if (stats.maxLineWidth > f) f = stats.maxLineWidth;
	}
	return { height: h, fit: f };
}

/** Measure a block node tree; returns rendered height and narrowest width that preserves the wrap. */
function measureNode(
	node: BlockNode,
	width: number,
	lineHeight: number,
): { height: number; fit: number } {
	switch (node.kind) {
		case "paragraph":
		case "heading":
			return measureLines(node.lines, width, lineHeight);
		case "list": {
			let inner = width - LIST_INDENT;
			let h = 0, f = 0;
			for (let item of node.items) {
				for (let child of item) {
					let m = measureNode(child, inner, lineHeight);
					h += m.height;
					if (m.fit > f) f = m.fit;
				}
			}
			return { height: h, fit: f + LIST_INDENT };
		}
		case "blockquote": {
			let inner = width - QUOTE_INDENT - QUOTE_BORDER;
			let h = 0, f = 0;
			for (let child of node.children) {
				let m = measureNode(child, inner, lineHeight);
				h += m.height;
				if (m.fit > f) f = m.fit;
			}
			return { height: h, fit: f + QUOTE_INDENT + QUOTE_BORDER };
		}
		case "table":
			return measureTable(node.rows, lineHeight);
		case "image":
			return imageBlock(node.src, 0, 0, node.alt).measure(width);
		case "hr":
			return { height: lineHeight, fit: 0 };
	}
}

function measureTable(rows: TableRow[], lineHeight: number): { height: number; fit: number } {
	let cols = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
	let widths = Array.from({ length: cols }, () => 0);
	let height = TABLE_BORDER * 2;

	for (let row of rows) {
		let h = lineHeight + CELL_PAD_Y * 2;
		for (let i = 0; i < row.cells.length; i++) {
			let cell = row.cells[i]!;
			let m = measureLines(cell.lines, TABLE_WIDTH, lineHeight);
			widths[i] = Math.max(widths[i]!, m.fit);
			h = Math.max(h, m.height + CELL_PAD_Y * 2);
		}
		height += h;
	}

	let fit = widths.reduce(
		(sum, width) => sum + Math.ceil(width) + CELL_PAD_X * 2,
		TABLE_BORDER * 2,
	);
	if (cols > 1) fit += cols - 1;
	return { height, fit };
}

function measureBlocks(
	blocks: BlockNode[],
	width: number,
	lineHeight: number,
): { height: number; fit: number } {
	let h = 0, f = 0;
	for (let node of blocks) {
		let m = measureNode(node, width, lineHeight);
		h += m.height;
		if (m.fit > f) f = m.fit;
	}
	if (blocks.length > 1) h += (blocks.length - 1) * BLOCK_GAP;
	return { height: h, fit: Math.ceil(f) };
}

/** Render inline nodes for a single line, wrapped where Pretext wraps it at `width`. */
function LineView({ line, fonts, width }: { line: Line; fonts: FontConfig; width?: number }) {
	let es = emojiStyle(fonts);
	let cs = codeStyle(fonts);
	let wraps = width === undefined ? NO_WRAPS : wrapsAt(line, width);
	return (
		<>
			{line.nodes.map((node, i) => {
				let key = inline(node, i);
				let at = wraps.breaks.get(i);
				let el: ReactNode;
				switch (node.kind) {
					case "mention":
						el = (
							<span className="mention">
								<span className="mention-copy">@</span>
								{node.avatar && (
									<span className="mention-avatar" style={avatarStyle(node.avatar)} />
								)}
								<span className="chip-name">{node.name}</span>
							</span>
						);
						break;
					case "emoji":
						el = node.src
							? <img src={node.src} alt={node.name} style={es} />
							: <span>:{node.name}:</span>;
						break;
					case "document":
						el = <LocalReference kind="document" uid={node.uid} name={node.name} />;
						break;
					case "plan":
						el = <LocalReference kind="plan" prefix={node.reference.startsWith("&")} />;
						break;
					case "code": {
						// A break at the item's start stays outside `<code>`, so it can't draw an empty box.
						let wrap = within(line.items[i]!, at);
						return (
							<Fragment key={key}>
								{wrap.lead && <Wrap />}
								<code style={cs}>{wrapText(node.text, wrap.offsets, key)}</code>
							</Fragment>
						);
					}
					case "link":
						return (
							<a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
								{wrapText(node.text, at, key)}
							</a>
						);
					case "text":
						return <Fragment key={key}>{adorn(wrapText(node.text, at, key), node)}</Fragment>;
				}
				return (
					<Fragment key={key}>
						{at && <Wrap />}
						{wraps.wide.has(i) ? <span className="line-clip" title={label(node)}>{el}</span> : el}
					</Fragment>
				);
			})}
		</>
	);
}

/** Render multiple lines within a block, joined by `<br>`. */
function LinesView({ lines, fonts, width }: { lines: Line[]; fonts: FontConfig; width?: number }) {
	return (
		<>
			{lines.map((line, i) => (
				<Fragment key={lineid(line, i)}>
					{i > 0 && <br />}
					<LineView line={line} fonts={fonts} width={width} />
				</Fragment>
			))}
		</>
	);
}

function boxStyle(fonts: FontConfig, height: number): CSSProperties {
	return {
		blockSize: height,
		boxSizing: "border-box",
		display: "flex",
		flexDirection: "column",
		gap: BLOCK_GAP,
		font: fonts.font,
		lineHeight: `${fonts.lineHeight}px`,
		// Lines break only at Pretext's wraps, so the browser can't add a line the height lacks.
		// Subpixel shaping drift may paint into the bubble padding instead of being cut off.
		whiteSpace: "nowrap",
		overflowX: "visible",
		overflowY: "clip",
	};
}

function animate(node: ReactNode, key: string, active: boolean) {
	return (
		<span key={key} className={active ? "stream-token stream-token-new" : "stream-token"}>
			{node}
		</span>
	);
}

function adorn(node: ReactNode, source: Line["nodes"][number]) {
	let el = node;
	if (source.kind !== "text") return el;
	if (source.strike) el = <s>{el}</s>;
	if (source.underline) el = <u>{el}</u>;
	if (source.italic) el = <em>{el}</em>;
	if (source.bold) el = <strong>{el}</strong>;
	return el;
}

/** Stream tokens of `text`, with `null` where a wrap offset forces a line break. */
function streamParts(text: string, offsets: number[] = []): (string | null)[] {
	let out: (string | null)[] = [];
	let at = 0;
	let k = 0;
	for (let part of pieces(text)) {
		let end = at + part.length;
		while (k < offsets.length && offsets[k]! < end) {
			let cut = offsets[k++]! - at;
			if (cut > 0) {
				out.push(part.slice(0, cut));
				part = part.slice(cut);
				at += cut;
			}
			out.push(null);
		}
		out.push(part);
		at = end;
	}
	return out;
}

function LineStream({ line, fonts, path, track, width }: {
	line: Line;
	fonts: FontConfig;
	path: string;
	track: Track;
	width: number;
}) {
	let es = emojiStyle(fonts);
	let cs = codeStyle(fonts);
	let wraps = wrapsAt(line, width);

	return (
		<>
			{line.nodes.map((node, i) => {
				let key = pathid(path, i);
				let at = wraps.breaks.get(i);
				let parts = (text: string, offsets: number[] | undefined, adorned: boolean) =>
					streamParts(text, offsets).map(
						(part, j) =>
							part === null
								? <Wrap key={pathid(key, j)} />
								: animate(
									adorned ? adorn(part, node) : part,
									pathid(key, j),
									fresh(track, part),
								),
					);
				let el: ReactNode;
				switch (node.kind) {
					case "mention":
						el = animate(
							<span className="mention">
								<span className="mention-copy">@</span>
								{node.avatar && (
									<span className="mention-avatar" style={avatarStyle(node.avatar)} />
								)}
								<span className="chip-name">{node.name}</span>
							</span>,
							key,
							fresh(track, "@" + node.name),
						);
						break;
					case "emoji":
						el = animate(
							node.src
								? <img src={node.src} alt={node.name} style={es} />
								: <span>:{node.name}:</span>,
							key,
							fresh(track, ":" + node.name + ":"),
						);
						break;
					case "document":
						el = animate(
							<LocalReference kind="document" uid={node.uid} name={node.name} />,
							key,
							fresh(track, "&" + node.reference),
						);
						break;
					case "plan":
						el = animate(
							<LocalReference kind="plan" prefix={node.reference.startsWith("&")} />,
							key,
							fresh(track, node.reference),
						);
						break;
					case "code": {
						let wrap = within(line.items[i]!, at);
						return (
							<Fragment key={key}>
								{wrap.lead && <Wrap />}
								<code style={cs}>{parts(node.text, wrap.offsets, false)}</code>
							</Fragment>
						);
					}
					case "link":
						return (
							<a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
								{parts(node.text, at, false)}
							</a>
						);
					case "text":
						return <Fragment key={key}>{parts(node.text, at, true)}</Fragment>;
				}
				return (
					<Fragment key={key}>
						{at && <Wrap />}
						{wraps.wide.has(i) ? <span className="line-clip" title={label(node)}>{el}</span> : el}
					</Fragment>
				);
			})}
		</>
	);
}

function LinesStream({ lines, fonts, path, track, width }: {
	lines: Line[];
	fonts: FontConfig;
	path: string;
	track: Track;
	width: number;
}) {
	return (
		<>
			{lines.map((line, i) => (
				<Fragment key={pathid(path, i)}>
					{i > 0 && <br />}
					<LineStream
						line={line}
						fonts={fonts}
						path={pathid(path, i)}
						track={track}
						width={width}
					/>
				</Fragment>
			))}
		</>
	);
}

function NodeStream({ node, fonts, path, track, width }: {
	node: BlockNode;
	fonts: FontConfig;
	path: string;
	track: Track;
	width: number;
}) {
	switch (node.kind) {
		case "paragraph":
			return (
				<p>
					<LinesStream
						lines={node.lines}
						fonts={fonts}
						path={path}
						track={track}
						width={width}
					/>
				</p>
			);
		case "heading":
			return (
				<p>
					<strong>
						<LinesStream
							lines={node.lines}
							fonts={fonts}
							path={path}
							track={track}
							width={width}
						/>
					</strong>
				</p>
			);
		case "list": {
			let inner = Math.max(0, width - LIST_INDENT);
			let items = node.items.map((item, i) => (
				<li key={pathid(path, i)}>
					{item.map((child, j) => (
						<NodeStream
							key={pathid(pathid(path, i), j)}
							node={child}
							fonts={fonts}
							path={pathid(pathid(path, i), j)}
							track={track}
							width={inner}
						/>
					))}
				</li>
			));
			return node.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
		}
		case "blockquote":
			let inner = Math.max(0, width - QUOTE_INDENT - QUOTE_BORDER);
			return (
				<blockquote>
					{node.children.map((child, i) => (
						<NodeStream
							key={pathid(path, i)}
							node={child}
							fonts={fonts}
							path={pathid(path, i)}
							track={track}
							width={inner}
						/>
					))}
				</blockquote>
			);
		case "table":
			return <TableView rows={node.rows} fonts={fonts} />;
		case "image":
			return <ImageNodeView node={node} width={width} />;
		case "hr":
			return <hr className="stream-token" />;
	}
}

function Stream({ blocks, fonts, compact, raw, active, height, width }: {
	blocks: BlockNode[];
	fonts: FontConfig;
	compact: boolean;
	raw: string;
	active: boolean;
	height: number;
	width: number;
}) {
	let edge = useRef(raw.length);
	let track = { raw, edge: edge.current, cursor: 0, active };
	let cls = compact ? "content measured thinking streaming" : "content measured streaming";
	if (active) cls += " streaming-live";

	useEffect(() => {
		edge.current = raw.length;
	}, [raw]);

	return (
		<div
			className={cls}
			style={boxStyle(fonts, height)}
		>
			{blocks.map((node, i) => (
				<NodeStream
					key={pathid("node", i)}
					node={node}
					fonts={fonts}
					path={pathid("node", i)}
					track={track}
					width={width}
				/>
			))}
		</div>
	);
}

function TextView({ blocks, fonts, compact, raw, streaming, height, width }: {
	blocks: BlockNode[];
	fonts: FontConfig;
	compact: boolean;
	raw: string;
	streaming: boolean;
	height: number;
	width: number;
}) {
	let [live, set] = useState(false);

	useEffect(() => {
		if (streaming) {
			set(true);
			return;
		}
		if (!live) return;
		let id = setTimeout(() => set(false));
		return () => clearTimeout(id);
	}, [streaming, live]);

	let active = streaming || live;
	if (active) {
		return (
			<Stream
				blocks={blocks}
				fonts={fonts}
				compact={compact}
				raw={raw}
				active={streaming}
				height={height}
				width={width}
			/>
		);
	}

	return (
		<div
			className={compact ? "content measured thinking" : "content measured"}
			style={boxStyle(fonts, height)}
		>
			{blocks.map((node, i) => (
				<NodeView key={nodeid(node, i)} node={node} fonts={fonts} width={width} />
			))}
		</div>
	);
}

/** Render a block node as semantic HTML. */
function NodeView({ node, fonts, width }: { node: BlockNode; fonts: FontConfig; width: number }) {
	switch (node.kind) {
		case "paragraph":
			return (
				<p>
					<LinesView lines={node.lines} fonts={fonts} width={width} />
				</p>
			);
		case "heading":
			return (
				<p>
					<strong>
						<LinesView lines={node.lines} fonts={fonts} width={width} />
					</strong>
				</p>
			);
		case "list": {
			let inner = Math.max(0, width - LIST_INDENT);
			let items = node.items.map((item, i) => (
				<li key={itemid(item, i)}>
					{item.map((child, j) => (
						<NodeView key={nodeid(child, j)} node={child} fonts={fonts} width={inner} />
					))}
				</li>
			));
			return node.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
		}
		case "blockquote":
			let inner = Math.max(0, width - QUOTE_INDENT - QUOTE_BORDER);
			return (
				<blockquote>
					{node.children.map((child, i) => (
						<NodeView key={nodeid(child, i)} node={child} fonts={fonts} width={inner} />
					))}
				</blockquote>
			);
		case "table":
			return <TableView rows={node.rows} fonts={fonts} />;
		case "image":
			return <ImageNodeView node={node} width={width} />;
		case "hr":
			return <hr />;
	}
}

function ImageNodeView(
	{ node, width }: { node: Extract<BlockNode, { kind: "image" }>; width: number },
) {
	return imageBlock(node.src, 0, 0, node.alt).render(width);
}

function TableView({ rows, fonts }: { rows: TableRow[]; fonts: FontConfig }) {
	let height = measureTable(rows, fonts.lineHeight).height;

	return (
		<div className="table-wrap" style={{ blockSize: height, boxSizing: "border-box" }}>
			<table>
				<tbody>
					{rows.map((row, i) => (
						<tr key={rowid(row, i)}>
							{row.cells.map((cell, j) => {
								let style = {
									paddingBlock: CELL_PAD_Y,
									paddingInline: CELL_PAD_X,
									textAlign: cell.align,
								};
								return cell.header
									? (
										<th
											key={cellid(cell, j)}
											style={style}
										>
											<LinesView lines={cell.lines} fonts={fonts} />
										</th>
									)
									: (
										<td
											key={cellid(cell, j)}
											style={style}
										>
											<LinesView lines={cell.lines} fonts={fonts} />
										</td>
									);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** Rich text block with full markdown support (paragraphs, lists, quotes, inline formatting). */
function text(
	raw: string,
	mentions?: Mention[],
	compact = false,
	streaming = false,
	parsed?: BlockNode[],
	plan = false,
): Block {
	let fonts = blockFonts(compact);
	let blocks = parsed || fallback(raw, mentions, fonts, plan);
	let sizes = new Map<number, { height: number; fit: number }>();
	let size = (width: number) => {
		let hit = sizes.get(width);
		if (hit) return hit;
		let value = measureBlocks(blocks, width, fonts.lineHeight);
		sizes.set(width, value);
		return value;
	};

	let block: Block & { streaming: boolean } = {
		streaming,
		measure(width) {
			return size(width);
		},
		render(width) {
			let height = size(width).height;
			return (
				<TextView
					blocks={blocks}
					fonts={fonts}
					compact={compact}
					raw={raw}
					streaming={block.streaming}
					height={height}
					width={width}
				/>
			);
		},
	};
	return block;
}

export { text };
