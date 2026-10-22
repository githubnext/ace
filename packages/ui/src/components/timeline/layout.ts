import { useEffect, useMemo, useRef, useState } from "react";
import { clearCache, layout, prepare } from "@chenglou/pretext";

import {
	call as callBlock,
	code as codeBlock,
	commit as commitBlock,
	diff as diffBlock,
	exec as execBlock,
	file as fileBlock,
	grid as gridBlock,
	image as imageBlock,
	issueComment as issueCommentBlock,
	issueOpened as issueOpenedBlock,
	issueUpdate as issueUpdateBlock,
	type Mention,
	pr as prBlock,
	prComment as prCommentBlock,
	presence as presenceBlock,
	prReview as prReviewBlock,
	prReviewComment as prReviewCommentBlock,
	prUpdate as prUpdateBlock,
	text as textBlock,
	tool as toolBlock,
} from "../blocks";
import { fonts, parseSegments, VERSION } from "../blocks/parse";
import { ROW_HEIGHT as TOOL_ROW_HEIGHT } from "../blocks/tool-layout";
import { measureReactions } from "../reactions/measure";
import { TURN_SUMMARY_CARD_GAP, turnSummaryHeight } from "../turn-summary/layout";
import type { Block, Measurement } from "../../lib/block";
import { isCommentChunk } from "../../lib/timeline";
import type { Chunk, TimelineItem, ToolNode, WorkingItem } from "../../lib/timeline";

// -- Layout constants --

const PAD = 12;
const GAP = 12;
const LINE = 22;
const BYLINE_HEIGHT = 16;
const AVATAR = 28;
const AVATAR_GAP = 8;
// Avatar has a 2px (mt-0.5) baseline nudge — included so the floor doesn't clip it.
const AVATAR_NUDGE = 2;
const CONTENT_GAP = 4;
const TURN_GAP = TURN_SUMMARY_CARD_GAP;
const HEADER_GAP = 4;
const PR_COMMENT_GAP = HEADER_GAP;
const PR_COMMENT_BODY_GAP = 12;
const PR_COMMENT_BUBBLE_PAD_BOTTOM = 10;
const BUBBLE_GAP = 2;
const BUBBLE_BORDER = 1;
const BUBBLE_PAD_X = 12;
const BUBBLE_PAD_Y = 5;
const FILES_HEIGHT = 20;
const TOOL_GROUP_ROW_HEIGHT = TOOL_ROW_HEIGHT;
const TOOL_GROUP_PAD_Y = 6;
const TOOL_LIST_INDENT = 12;
const WORKING_SUMMARY_HEIGHT = TOOL_GROUP_ROW_HEIGHT;
const WORKING_SUMMARY_PAD_END = 6;
const DAY_HEIGHT = 40;
const REACTION_GAP = 4;
const LANE = 52 * 16;
const TAIL = 40;

function summaryId(group: string, kind: "artifacts" | "files"): string {
	return `${group}:summary:${kind}`;
}

// -- Chunk → Block conversion --

/** LRU cap — bounds memory while staying generous for long sessions. */
const CACHE_MAX = 2000;
const PARSE_MAX = 1000;

/** Content-keyed LRU so unchanged chunks don't re-parse markdown on every render. */
let cache = new Map<string, Block[]>();
let parsed = new Map<string, { blocks?: Block[]; promise?: Promise<Block[]>; failed?: boolean }>();
let stream = new Map<string, Promise<Block[]>>();

// Pretext keeps the glyph widths it measured with whichever font was loaded at the time, so text
// measured while a web font is still loading keeps fallback widths until every cache drops them.
let fontEpoch = 0;
let fontStale = false;
let fontListeners = new Set<() => void>();

function refont() {
	clearCache();
	cache.clear();
	parsed.clear();
	stream.clear();
	measureCache = new WeakMap();
	fontEpoch++;
	fontStale = false;
	for (let listener of fontListeners) listener();
}

function onFonts(listener: () => void): () => void {
	if (!fontListeners.size) document.fonts.addEventListener("loadingdone", refont);
	fontListeners.add(listener);
	// A font that the render requested can finish loading before this subscription sees its event.
	void document.fonts.ready.then(() => {
		if (fontStale && document.fonts.check(fonts().font)) refont();
	});
	return () => {
		fontListeners.delete(listener);
		if (!fontListeners.size) document.fonts.removeEventListener("loadingdone", refont);
	};
}

type Payload = Exclude<Chunk, { kind: "text" }>;

type Slot = {
	raw: string;
	sig: string;
	blocks: Block[];
	parsed: boolean;
};

type KeyPart = boolean | number | string | null | undefined;

function joinKey(kind: string, mode: string, ...parts: KeyPart[]): string {
	return [
		kind,
		mode,
		...parts.map(part => {
			if (part == null) return "";
			if (typeof part === "boolean") return part ? "1" : "0";
			return String(part);
		}),
	].join("\0");
}

/** Derive a cache key for a chunk. */
function key(
	chunk: Payload,
	expanded: Set<string>,
	expandedResults: Set<string>,
	settling: Set<string>,
	streaming: boolean,
): string {
	let mode = streaming ? "stream" : "settled";
	switch (chunk.kind) {
		case "code":
			return joinKey("code", mode, chunk.language, chunk.source);
		case "diff":
			return joinKey("diff", mode, chunk.patch);
		case "image":
			return joinKey("image", mode, chunk.src, chunk.width, chunk.height, chunk.alt);
		case "image-grid":
			return joinKey(
				"grid",
				mode,
				...chunk.images.flatMap(img => [img.src, img.width, img.height, img.alt]),
			);
		case "file":
			return joinKey("file", mode, chunk.name, chunk.text);
		case "tool-group":
			return joinKey(
				"tools",
				mode,
				...chunk.tools.flatMap(t => [
					t.id,
					t.name,
					t.status,
					t.args,
					t.result,
					...(t.images || []),
					expanded.has(t.id),
					expandedResults.has(t.id),
					settling.has(t.id),
				]),
			);
		case "commit":
			return joinKey("commit", mode, chunk.sha, chunk.message, chunk.url);
		case "pr":
			return joinKey("pr", mode, chunk.pr, chunk.title, chunk.url);
		case "pr-update":
			return joinKey("pru", mode, chunk.pr, chunk.value, chunk.title, chunk.url);
		case "pr-comment":
			return joinKey("prc", mode, chunk.pr, chunk.author, chunk.url);
		case "pr-review":
			return joinKey("prr", mode, chunk.pr, chunk.action, chunk.reviewer, chunk.url, chunk.bubble);
		case "pr-review-comment":
			return joinKey(
				"prrc",
				mode,
				chunk.pr,
				chunk.author,
				chunk.path,
				chunk.line,
				chunk.url,
				chunk.bubble,
			);
		case "issue":
			return joinKey("iss", mode, chunk.issue, chunk.author, chunk.url);
		case "issue-comment":
			return joinKey("issc", mode, chunk.issue, chunk.author, chunk.url);
		case "issue-update":
			return joinKey("issu", mode, chunk.issue, chunk.value, chunk.url);
		case "exec":
			return joinKey(
				"exec",
				mode,
				chunk.id,
				chunk.input,
				chunk.cwd,
				chunk.exitCode,
				chunk.aborted,
				expanded.has(chunk.id),
				chunk.stdout,
				chunk.stderr,
			);
		case "presence":
			return joinKey("pres", mode, chunk.action, chunk.sender);
		case "call":
			return joinKey("call", mode, chunk.action, chunk.sender);
	}
}

function sync(blocks: Block[], streaming: boolean) {
	for (let block of blocks) (block as Block & { streaming?: boolean }).streaming = streaming;
}

function tools(
	items: ToolNode[],
	expanded: Set<string>,
	expandedResults: Set<string>,
	settling: Set<string> = new Set(),
): Block[] {
	return items.map(t =>
		toolBlock(
			{
				id: t.id,
				name: t.name,
				status: t.status,
				agent: t.agent,
				args: t.args,
				result: t.result,
				images: t.images,
			},
			expanded.has(t.id),
			expandedResults.has(t.id),
			settling.has(t.id),
		)
	);
}

/** Build Block[] for a structured chunk. */
function build(
	chunk: Payload,
	expanded: Set<string>,
	expandedResults: Set<string>,
	settling: Set<string>,
	streaming = false,
): Block[] {
	switch (chunk.kind) {
		case "code":
			return [codeBlock(chunk.source, chunk.language, streaming)];
		case "diff":
			return [diffBlock(chunk.patch, streaming)];
		case "image":
			return [imageBlock(chunk.src, chunk.width, chunk.height, chunk.alt)];
		case "image-grid":
			return [gridBlock(chunk.images)];
		case "file":
			return [fileBlock(chunk.name, chunk.text)];
		case "tool-group":
			return tools(chunk.tools, expanded, expandedResults, settling);
		case "commit":
			return [commitBlock(chunk.sha, chunk.message, chunk.url)];
		case "pr":
			return [prBlock(chunk.pr, chunk.title, chunk.url)];
		case "pr-update":
			return [prUpdateBlock(chunk.pr, chunk.url, chunk.value, chunk.title)];
		case "pr-comment":
			return [prCommentBlock(chunk.pr, chunk.author, chunk.url, BYLINE_HEIGHT)];
		case "pr-review":
			return [prReviewBlock(
				chunk.pr,
				chunk.action,
				chunk.reviewer,
				chunk.url,
				chunk.bubble ? BYLINE_HEIGHT : undefined,
			)];
		case "pr-review-comment":
			return [prReviewCommentBlock(
				chunk.author,
				chunk.path,
				chunk.line,
				chunk.url,
				chunk.bubble ? BYLINE_HEIGHT : undefined,
			)];
		case "issue":
			return [issueOpenedBlock(chunk.issue, chunk.author, chunk.url, BYLINE_HEIGHT)];
		case "issue-comment":
			return [issueCommentBlock(chunk.issue, chunk.author, chunk.url, BYLINE_HEIGHT)];
		case "issue-update":
			return [issueUpdateBlock(chunk.issue, chunk.url, chunk.value)];
		case "exec":
			return [
				execBlock(
					chunk.id,
					chunk.input,
					chunk.exitCode,
					chunk.aborted,
					chunk.stdout,
					chunk.stderr,
					expanded.has(chunk.id),
					chunk.cwd,
				),
			];
		case "presence":
			return [presenceBlock(chunk.action, chunk.sender)];
		case "call":
			return [callBlock(chunk.action, chunk.sender)];
	}
}

type Request = {
	key: string;
	raw: string;
	sig: string;
	mentions?: Mention[];
	plan: boolean;
	compact: boolean;
	streaming: boolean;
	slot?: string;
};

function parseKey(raw: string, sig: string, compact: boolean, streaming: boolean): string {
	return [
		"comark",
		VERSION,
		compact ? "compact" : "regular",
		streaming ? "stream" : "settled",
		sig,
		raw,
	]
		.join("\0");
}

function bump<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
	if (map.has(key)) map.delete(key);
	while (map.size >= max) map.delete(map.keys().next().value!);
	map.set(key, value);
}

async function parse(req: Request): Promise<Block[]> {
	let parts = await parseSegments(
		req.raw,
		req.mentions,
		fonts(req.compact),
		req.streaming,
		undefined,
		req.plan,
	);
	let blocks: Block[] = [];
	for (let part of parts) {
		if (part.kind === "text") {
			blocks.push(
				textBlock(part.raw, req.mentions, req.compact, req.streaming, part.blocks, req.plan),
			);
		} else if (part.kind === "diff") {
			blocks.push(diffBlock(part.patch, req.streaming));
		} else {
			blocks.push(codeBlock(part.source, part.language, req.streaming, part.nodes));
		}
	}
	return blocks;
}

function start(req: Request): Promise<Block[]> {
	if (req.streaming && req.slot) {
		let hit = stream.get(req.slot);
		if (hit) return hit;
	}

	let hit = parsed.get(req.key);
	if (hit?.promise) return hit.promise;

	let entry = hit || {};
	let epoch = fontEpoch;
	entry.promise = parse(req).then(
		blocks => {
			// Blocks prepared before fonts changed are stale; the next render parses again.
			if (epoch !== fontEpoch) return blocks;
			entry.blocks = blocks;
			entry.promise = undefined;
			bump(parsed, req.key, entry, PARSE_MAX);
			return blocks;
		},
		error => {
			// A failed parse must settle, not disappear. Deleting the cache entry here
			// let the render loop re-queue the same chunk every tick — a single poison
			// input (e.g. an imported issue/PR body that trips the parser) would spin
			// forever, pegging the CPU and thrashing memory until the app froze.
			// Instead, fall back to the raw-text placeholder and cache it as settled so
			// the offending message renders as plain text and the loop converges.
			console.error("timeline: markdown parse failed; rendering raw text", error);
			let fallback = placeholder(
				req.raw,
				req.mentions,
				req.plan,
				req.sig,
				req.compact,
				req.streaming,
			);
			entry.blocks = fallback;
			entry.promise = undefined;
			entry.failed = true;
			bump(parsed, req.key, entry, PARSE_MAX);
			return fallback;
		},
	);
	if (req.streaming && req.slot) {
		let promise = entry.promise;
		stream.set(req.slot, promise);
		promise.then(
			() => {
				if (stream.get(req.slot!) === promise) stream.delete(req.slot!);
			},
			() => {
				if (stream.get(req.slot!) === promise) stream.delete(req.slot!);
			},
		);
	}
	bump(parsed, req.key, entry, PARSE_MAX);
	return entry.promise;
}

function placeholder(
	raw: string,
	mentions: Mention[] | undefined,
	plan: boolean,
	sig: string,
	compact: boolean,
	streaming: boolean,
): Block[] {
	let k = "placeholder\0" + parseKey(raw, sig, compact, streaming);
	let hit = cache.get(k);
	if (hit) {
		sync(hit, streaming);
		bump(cache, k, hit, CACHE_MAX);
		return hit;
	}
	let blocks = [textBlock(raw, mentions, compact, streaming, undefined, plan)];
	bump(cache, k, blocks, CACHE_MAX);
	return blocks;
}

function textBlocks(
	chunk: Extract<Chunk, { kind: "text" }>,
	mentions: Mention[] | undefined,
	sig: string,
	compact: boolean,
	streaming: boolean,
	slot: string,
	prev: Map<string, Slot>,
	next: Map<string, Slot>,
	jobs: Request[],
	seen: Set<string>,
	plan = false,
): Block[] {
	let k = parseKey(chunk.raw, sig, compact, streaming);
	let old = prev.get(slot);
	if (!streaming && old?.parsed && old.raw === chunk.raw && old.sig === sig) {
		sync(old.blocks, streaming);
		next.set(slot, old);
		return old.blocks;
	}

	let hit = parsed.get(k)?.blocks;
	if (hit) {
		sync(hit, streaming);
		next.set(slot, { raw: chunk.raw, sig, blocks: hit, parsed: true });
		return hit;
	}

	// Queue in-flight parses too: start() reuses their promise, and this render's tick must not
	// depend on an earlier render whose effect may already have been cancelled.
	if (!seen.has(k)) {
		jobs.push({ key: k, raw: chunk.raw, sig, mentions, plan, compact, streaming, slot });
		seen.add(k);
	}

	let keep = old;
	let blocks = keep?.blocks || placeholder(chunk.raw, mentions, plan, sig, compact, streaming);
	sync(blocks, streaming);
	next.set(slot, {
		raw: chunk.raw,
		sig,
		blocks,
		parsed: !!keep && keep.raw === chunk.raw && keep.sig === sig && keep.parsed,
	});
	return blocks;
}

/** Convert a timeline content chunk into Block instances, memoized by content (LRU). */
function toBlocks(
	chunk: Payload,
	expanded: Set<string>,
	expandedResults: Set<string>,
	settling: Set<string> = new Set(),
	streaming = false,
): Block[] {
	let k = key(chunk, expanded, expandedResults, settling, streaming);
	let hit = cache.get(k);
	if (hit) {
		sync(hit, streaming);
		bump(cache, k, hit, CACHE_MAX);
		return hit;
	}
	let blocks = build(chunk, expanded, expandedResults, settling, streaming);
	bump(cache, k, blocks, CACHE_MAX);
	return blocks;
}

/**
 * Per-block measurement cache keyed by width.
 * Block instances come from the LRU-cached `toBlocks` so references are stable —
 * a WeakMap keeps us free of the GC bookkeeping. Frame-build populates; render reads.
 */
let measureCache = new WeakMap<Block, Map<number, Measurement>>();

/** Memoized single-pass measurement: one Pretext walk covers both height and fit. */
function measureBlock(block: Block, width: number): Measurement {
	let byWidth = measureCache.get(block);
	if (!byWidth) {
		byWidth = new Map();
		measureCache.set(block, byWidth);
	}
	let hit = byWidth.get(width);
	if (hit) return hit;
	let m = block.measure(width);
	byWidth.set(width, m);
	return m;
}

/** Aggregate measurement across a row's blocks: summed height, max fit. */
function measureRow(blocks: Block[], width: number): Measurement {
	let h = 0, f = 0;
	for (let b of blocks) {
		let m = measureBlock(b, width);
		h += m.height;
		if (m.fit > f) f = m.fit;
	}
	return { height: h, fit: f };
}

/** Stable signature for a mentions list — used to key the text-block cache. */
function mentionsSig(mentions?: Mention[]): string {
	if (!mentions?.length) return "";
	let s = "";
	for (let m of mentions) s += m.name + "\0" + (m.avatar || "") + "\0";
	return s;
}

function eventTextCompact(chunks: Chunk[]): boolean {
	return !isCommentChunk(chunks[0]?.kind);
}

async function parseBlockMap(
	timeline: TimelineItem[],
	mentions?: Mention[],
	expanded: Set<string> = new Set(),
	expandedResults: Set<string> = new Set(),
	settling: Set<string> = new Set(),
	plan = false,
): Promise<Map<string, Block[]>> {
	let jobs: Promise<readonly [string, Block[]]>[] = [];
	let sig = mentionsSig(mentions) + (plan ? "\0plan" : "");

	let convert = async (chunks: Chunk[], id: string, compact = false, streaming = false) => {
		let parts = await Promise.all(chunks.map(async chunk => {
			if (chunk.kind !== "text") {
				return toBlocks(chunk, expanded, expandedResults, settling, streaming);
			}
			let key = parseKey(chunk.raw, sig, compact, streaming);
			let blocks = parsed.get(key)?.blocks || await start({
				key,
				raw: chunk.raw,
				sig,
				mentions,
				plan,
				compact,
				streaming,
			});
			sync(blocks, streaming);
			return blocks;
		}));
		return [id, parts.flat()] as const;
	};

	for (let item of timeline) {
		if (item.kind === "day" || item.kind === "new") continue;
		if (item.kind === "event") {
			jobs.push(convert(item.row.chunks, item.row.uid, eventTextCompact(item.row.chunks)));
			continue;
		}

		let { group, turn } = item;
		if (turn) {
			for (let w of turn.working) {
				if (w.type === "text") jobs.push(convert(w.chunks, w.id));
				else {
					jobs.push(
						Promise.resolve([w.id, tools(w.tools, expanded, expandedResults, settling)]),
					);
				}
			}
			if (turn.final) {
				jobs.push(convert(turn.final.chunks, turn.final.uid, false, !!turn.final.streaming));
			}
		} else {
			for (let row of group.rows) jobs.push(convert(row.chunks, row.uid));
		}
	}

	return new Map(await Promise.all(jobs));
}

function useBlockMap(
	timeline: TimelineItem[],
	mentions?: Mention[],
	expanded: Set<string> = new Set(),
	expandedResults: Set<string> = new Set(),
	settling: Set<string> = new Set(),
	plan = false,
): Map<string, Block[]> {
	let [tick, setTick] = useState(0);
	let prev = useRef(new Map<string, Slot>());
	let sig = mentionsSig(mentions) + (plan ? "\0plan" : "");
	let memo = useMemo(() => {
		if (!document.fonts.check(fonts().font)) fontStale = true;
		let map = new Map<string, Block[]>();
		let next = new Map<string, Slot>();
		let jobs: Request[] = [];
		let seen = new Set<string>();

		let convert = (
			chunks: Chunk[],
			id: string,
			compact = false,
			streaming = false,
		): Block[] => {
			let out: Block[] = [];
			for (let i = 0; i < chunks.length; i++) {
				let chunk = chunks[i]!;
				if (chunk.kind === "text") {
					out.push(...textBlocks(
						chunk,
						mentions,
						sig,
						compact,
						streaming,
						`${id}:${i}:${compact ? "1" : "0"}`,
						prev.current,
						next,
						jobs,
						seen,
						plan,
					));
				} else {
					out.push(...toBlocks(chunk, expanded, expandedResults, settling, streaming));
				}
			}
			return out;
		};

		for (let item of timeline) {
			if (item.kind === "day" || item.kind === "new") continue;
			if (item.kind === "event") {
				map.set(
					item.row.uid,
					convert(
						item.row.chunks,
						item.row.uid,
						eventTextCompact(item.row.chunks),
					),
				);
				continue;
			}

			let { group, turn } = item;
			if (turn) {
				for (let w of turn.working) {
					if (w.type === "text") map.set(w.id, convert(w.chunks, w.id));
					else {
						map.set(w.id, tools(w.tools, expanded, expandedResults, settling));
					}
				}
				if (turn.final) {
					map.set(
						turn.final.uid,
						convert(turn.final.chunks, turn.final.uid, false, !!turn.final.streaming),
					);
				}
			} else {
				for (let row of group.rows) map.set(row.uid, convert(row.chunks, row.uid));
			}
		}

		return { jobs, map, next };
	}, [expanded, expandedResults, settling, sig, tick, timeline, mentions, plan]);

	// Publish the parse cache after commit so interrupted renders do not become the next baseline.
	useEffect(() => {
		prev.current = memo.next;
	}, [memo]);

	useEffect(() =>
		onFonts(() => {
			prev.current = new Map();
			setTick(tick => tick + 1);
		}), []);

	// Missing markdown parses finish outside React; tick once they settle so measurement rebuilds.
	useEffect(() => {
		if (!memo.jobs.length) return;
		let cancelled = false;
		Promise.all(memo.jobs.map(start)).then(
			() => {
				if (!cancelled) setTick(tick => tick + 1);
			},
			() => {
				if (!cancelled) setTick(tick => tick + 1);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [memo.jobs]);

	return memo.map;
}

// -- Height computation --

/** Exact pixel height for a timeline item at a given container width. */
function itemHeight(
	item: TimelineItem,
	blocks: Map<string, Block[]>,
	width: number,
	open: Set<string> = new Set(),
	openWorking: Set<string> = new Set(),
): number {
	if (item.kind === "day" || item.kind === "new") return DAY_HEIGHT;
	if (item.kind === "event") {
		let b = blocks.get(item.row.uid);
		let content = width - PAD * 2 - AVATAR - AVATAR_GAP;
		if (!b) return AVATAR + AVATAR_NUDGE;
		if (isCommentChunk(item.row.chunks[0]?.kind) && b.length > 1) {
			let head = b[0]!;
			let body = b.slice(1);
			let inner = content - BUBBLE_PAD_X * 2;
			let height = measureRow([head], content).height;
			let bodyHeight = measureRow(body, inner).height;
			if (body.length > 1) bodyHeight += (body.length - 1) * PR_COMMENT_BODY_GAP;
			height += PR_COMMENT_GAP + bodyHeight + BUBBLE_PAD_Y + PR_COMMENT_BUBBLE_PAD_BOTTOM;
			return Math.max(height, AVATAR + AVATAR_NUDGE);
		}
		let height = measureRow(b, content).height;
		if (b.length > 1) height += (b.length - 1) * CONTENT_GAP;
		return Math.max(height, AVATAR + AVATAR_NUDGE);
	}

	let { group, turn } = item;
	let content = width - PAD * 2 - AVATAR - AVATAR_GAP;
	let h = 0;
	let hasByline = group.rows.length > 0;
	if (hasByline) h += BYLINE_HEIGHT;

	if (turn) {
		if (hasByline) h += HEADER_GAP;
		let children = 0;

		if (turn.working.length) {
			let working = content - BUBBLE_PAD_X * 2;
			let header = turn.final ? workingHeaderHeight(turn.recap, working) : 0;
			let expanded = !turn.final || openWorking.has(group.id);
			h += workingSectionHeight(turn.working, blocks, working, open, header, expanded);
			children++;
		}

		if (turn.final) {
			let b = blocks.get(turn.final.uid);
			let inner = content - BUBBLE_PAD_X * 2;
			if (b) {
				h += measureRow(b, inner).height;
				if (b.length > 1) h += (b.length - 1) * CONTENT_GAP;
			}
			h += BUBBLE_PAD_Y * 2;
			if (turn.final.reactions?.length) {
				h += REACTION_GAP + measureReactions(turn.final.reactions, content);
			}
			children++;
		}

		if (turn.artifacts.length || turn.files.length) {
			h += turnSummaryHeight(
				turn.artifacts,
				turn.files,
				open.has(summaryId(group.id, "artifacts")),
				open.has(summaryId(group.id, "files")),
			);
			children++;
		}
		if (children === 0 && !hasByline) h = LINE * 2;
		else if (children > 1) h += (children - 1) * TURN_GAP;
	} else {
		for (let row of group.rows) {
			let isBubble = group.role === "user" || group.role === "assistant";
			let w = isBubble ? content - BUBBLE_PAD_X * 2 : content;
			let b = blocks.get(row.uid);
			if (b) h += measureRow(b, w).height;
			if (isBubble) h += BUBBLE_PAD_Y * 2;
			if (row.reactions?.length) {
				h += REACTION_GAP + measureReactions(row.reactions, content);
			}
		}
		if (hasByline) h += HEADER_GAP;
		let rowGap = group.role === "user" ? BUBBLE_GAP : CONTENT_GAP;
		if (group.rows.length > 1) h += (group.rows.length - 1) * rowGap;
	}

	h += CONTENT_GAP;

	return Math.max(h, AVATAR + AVATAR_NUDGE);
}

function workingSectionHeight(
	items: WorkingItem[],
	blocks: Map<string, Block[]>,
	width: number,
	open: Set<string>,
	header: number,
	expanded: boolean,
): number {
	let h = BUBBLE_PAD_Y * 2 + BUBBLE_BORDER * 2 + header;
	if (!expanded) return h;
	let content = 0;
	let count = 0;
	for (let item of items) {
		content += workingHeight(item, blocks, width, open);
		count++;
	}
	if (count > 1) content += (count - 1) * CONTENT_GAP;
	if (header && count) content += CONTENT_GAP;
	return h + content;
}

/** The folded turn's label row, below its recap when there is one. */
function workingHeaderHeight(recap: string | undefined, width: number): number {
	if (!recap) return WORKING_SUMMARY_HEIGHT;
	let { font, lineHeight } = fonts();
	return layout(prepare(recap, font), width - WORKING_SUMMARY_PAD_END, lineHeight).height
		+ WORKING_SUMMARY_HEIGHT;
}

function workingHeight(
	item: WorkingItem,
	blocks: Map<string, Block[]>,
	width: number,
	open: Set<string>,
): number {
	let b = blocks.get(item.id) || [];
	if (item.type === "text") {
		let h = measureRow(b, width).height;
		if (b.length > 1) h += (b.length - 1) * CONTENT_GAP;
		return h;
	}

	let h = TOOL_GROUP_ROW_HEIGHT + TOOL_GROUP_PAD_Y * 2;
	if (!open.has(item.id) || !b.length) return h;
	h += measureRow(b, width - TOOL_LIST_INDENT).height;
	h += b.length * CONTENT_GAP;
	return h;
}

export {
	AVATAR,
	AVATAR_GAP,
	AVATAR_NUDGE,
	BUBBLE_BORDER,
	BUBBLE_GAP,
	BUBBLE_PAD_X,
	BUBBLE_PAD_Y,
	BYLINE_HEIGHT,
	CONTENT_GAP,
	DAY_HEIGHT,
	FILES_HEIGHT,
	GAP,
	HEADER_GAP,
	itemHeight,
	LANE,
	LINE,
	measureRow,
	PAD,
	parseBlockMap,
	PR_COMMENT_BODY_GAP,
	PR_COMMENT_BUBBLE_PAD_BOTTOM,
	PR_COMMENT_GAP,
	REACTION_GAP,
	summaryId,
	TAIL,
	textBlocks,
	TOOL_GROUP_PAD_Y,
	TOOL_GROUP_ROW_HEIGHT,
	TOOL_LIST_INDENT,
	TURN_GAP,
	useBlockMap,
	WORKING_SUMMARY_HEIGHT,
	WORKING_SUMMARY_PAD_END,
};
