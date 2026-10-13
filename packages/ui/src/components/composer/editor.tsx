import {
	type ComponentPropsWithRef,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { SearchIndex } from "emoji-mart";

import { initEmoji } from "../../lib/emoji";
import { cn, isUrl } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverPortal, PopoverPositioner } from "../../ui/popover";

import { edit, type Format, format, link } from "./format";

/** Someone `@name` can address. */
type Mention = { name: string; avatar?: string; id?: string };

type Item = {
	key: string;
	label: string;
	avatar?: string;
	/** Text that replaces the typed query. */
	text: string;
};

type Popup = { from: number; items: Item[]; index: number };

type EmojiHit = { id: string; name: string; skins: { native?: string; src?: string }[] };

const MENTION = /(^|[\s([{])@([\w.-]*)$/;
const EMOJI = /(^|\s):([\w+-]{2,})$/;
const SHORTCODE = /(^|\s):([\w+-]+):$/;

const KEYS: Record<string, Format> = {
	b: "bold",
	i: "italic",
	u: "underline",
	e: "code",
	k: "link",
	"shift+s": "strike",
	"shift+>": "quote",
	"alt+7": "ordered",
	"alt+8": "bullet",
	"alt+`": "pre",
};

/**
 * The textarea's text drawn beneath it, with known mentions as chips. A chip keeps every glyph's
 * width so the caret and selection stay aligned: its avatar covers the `@`, and its pill is drawn
 * outside the text box.
 */
function marked(text: string, mentions: Mention[] | undefined): ReactNode[] {
	if (!mentions?.length) return [text];
	let names = mentions.map(item => item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	let re = new RegExp(`(^|\\s)@(${names})\\b`, "gi");
	let out: ReactNode[] = [];
	let last = 0;
	for (let match of text.matchAll(re)) {
		let at = match.index + match[1]!.length;
		let name = match[2]!;
		let avatar = mentions.find(item => item.name.toLowerCase() === name.toLowerCase())?.avatar;
		out.push(text.slice(last, at));
		out.push(
			<span key={at} className="composer-mention">
				<span className={avatar ? "text-transparent" : undefined}>@</span>
				{avatar && <img src={avatar} alt="" />}
				{name}
			</span>,
		);
		last = at + name.length + 1;
	}
	out.push(text.slice(last));
	return out;
}

/** No mouse or trackpad: a phone, or a tablet without a keyboard case. */
function touchOnly() {
	return !matchMedia("(any-pointer: fine)").matches;
}

function shortcut(e: KeyboardEvent) {
	if (!(e.metaKey || e.ctrlKey)) return undefined;
	// Option changes `e.key` on macOS, so read the physical digit or backquote.
	let key = e.altKey ? e.code.replace(/^Digit/, "").replace("Backquote", "`") : e.key.toLowerCase();
	return KEYS[[e.altKey && "alt", e.shiftKey && "shift", key].filter(Boolean).join("+")];
}

async function emojis(query: string): Promise<EmojiHit[]> {
	return (await SearchIndex.search(query, { maxResults: 8, caller: null })) || [];
}

type Props =
	& Omit<
		ComponentPropsWithRef<"textarea">,
		"defaultValue" | "onChange" | "onKeyDown" | "onSubmit" | "ref"
	>
	& {
		ref?: Ref<HTMLTextAreaElement | null>;
		defaultValue?: string;
		mentions?: Mention[];
		/** Called with the full text after every edit. */
		onChange?: (text: string) => void;
		/** Called before built-in key handling. Return true to consume the event. */
		onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
		/** Called on Enter without Shift. */
		onSubmit?: () => void;
		/** Receives pasted images. */
		onFiles?: (files: File[]) => void;
	};

/** Markdown source editor: a plain textarea with mention and emoji autocomplete. */
function Editor(
	{
		ref,
		defaultValue,
		mentions,
		onChange,
		onKeyDown,
		onSubmit,
		onFiles,
		hidden,
		className,
		...props
	}: Props,
) {
	let el = useRef<HTMLTextAreaElement>(null);
	let mirror = useRef<HTMLDivElement>(null);
	let [text, setText] = useState(defaultValue ?? "");
	let [popup, setPopup] = useState<Popup | null>(null);
	let query = useRef(0);
	useImperativeHandle<HTMLTextAreaElement | null, HTMLTextAreaElement | null>(
		ref,
		() => el.current,
	);

	useEffect(initEmoji, []);
	// A hidden textarea measures no height, so fit again whenever it is shown.
	useLayoutEffect(() => fit(), [hidden]);
	useEffect(() => {
		let area = el.current;
		if (!area) return;
		let width = area.clientWidth;
		// Rewrapping at a new width changes the height the text needs.
		let observer = new ResizeObserver(() => {
			if (area.clientWidth === width) return;
			width = area.clientWidth;
			fit();
		});
		observer.observe(area);
		return () => observer.disconnect();
	}, []);

	function fit() {
		let area = el.current;
		if (!area) return;
		area.style.height = "auto";
		area.style.height = `${area.scrollHeight}px`;
		// A scrollbar narrows the textarea's text; the mirror must wrap at the same width.
		mirror.current?.style.setProperty("width", `${area.clientWidth}px`);
	}

	async function suggest(area: HTMLTextAreaElement) {
		let id = ++query.current;
		let { value, selectionStart: at, selectionEnd } = area;
		let before = at === selectionEnd ? value.slice(0, at) : "";
		let mention = MENTION.exec(before);
		if (mention && mentions?.length) {
			let q = mention[2]!.toLowerCase();
			let items = mentions
				.filter(item => item.name.toLowerCase().includes(q))
				.map(item => ({
					key: item.name,
					label: item.name,
					avatar: item.avatar,
					text: `@${item.name} `,
				}));
			return show(at - q.length - 1, items);
		}
		let emoji = EMOJI.exec(before);
		if (!emoji) return setPopup(null);
		let hits = await emojis(emoji[2]!);
		if (id !== query.current) return;
		let items = hits.map(hit => {
			let native = hit.skins[0]?.native;
			return {
				key: hit.id,
				label: native ? `${native} ${hit.name}` : hit.name,
				avatar: native ? undefined : hit.skins[0]?.src,
				text: native || `:${hit.id}: `,
			};
		});
		show(at - emoji[2]!.length - 1, items);
	}

	function show(from: number, items: Item[]) {
		if (!items.length) return setPopup(null);
		setPopup(prev => ({ from, items, index: Math.min(prev?.index ?? 0, items.length - 1) }));
	}

	function accept(item: Item) {
		let area = el.current;
		if (!area || !popup) return;
		setPopup(null);
		edit(area, popup.from, area.selectionStart, item.text);
	}

	/** A typed `:name:` becomes its emoji, as accepting the suggestion would. */
	async function shortcode(area: HTMLTextAreaElement) {
		let at = area.selectionStart;
		let match = SHORTCODE.exec(area.value.slice(0, at));
		if (!match) return;
		let name = match[2]!.toLowerCase();
		let hit = (await emojis(name)).find(e =>
			e.id.toLowerCase() === name || e.name.toLowerCase() === name
		);
		let native = hit?.skins[0]?.native;
		let from = at - name.length - 2;
		if (!native || area.value.slice(from, at).toLowerCase() !== `:${name}:`) return;
		edit(area, from, at, native);
	}

	function input(area: HTMLTextAreaElement, typed: string | null) {
		setText(area.value);
		fit();
		onChange?.(area.value);
		void suggest(area);
		if (typed === ":") void shortcode(area);
	}

	function keydown(e: KeyboardEvent<HTMLTextAreaElement>) {
		let area = e.currentTarget;
		if (popup && !e.nativeEvent.isComposing) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				let step = e.key === "ArrowDown" ? 1 : -1;
				return setPopup({
					...popup,
					index: (popup.index + step + popup.items.length) % popup.items.length,
				});
			}
			if (e.key === "Escape") {
				e.preventDefault();
				return setPopup(null);
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				return accept(popup.items[popup.index]!);
			}
		}
		if (onKeyDown?.(e)) return;
		let kind = shortcut(e);
		if (kind) {
			e.preventDefault();
			return format(area, kind);
		}
		if (e.key !== "Enter" || !onSubmit || e.shiftKey || e.altKey || e.nativeEvent.isComposing) {
			return;
		}
		// A phone's Return key adds a line, as in other mobile chat apps; its Send button sends.
		if (e.metaKey || e.ctrlKey || !touchOnly()) {
			e.preventDefault();
			onSubmit();
		}
	}

	return (
		<div className={cn("composer-editor", className)} hidden={hidden}>
			<div ref={mirror} aria-hidden className="composer-mirror">
				{marked(text, mentions)}
				{/* A trailing line break needs a glyph after it to take up its line. */}
				{"\u200b"}
			</div>
			<textarea
				ref={el}
				rows={1}
				defaultValue={defaultValue}
				spellCheck
				className="composer-textarea"
				onScroll={e => {
					if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
				}}
				onInput={e => input(e.currentTarget, (e.nativeEvent as InputEvent).data)}
				onKeyDown={keydown}
				onBlur={() => setPopup(null)}
				onPaste={e => {
					let data = e.clipboardData;
					// Spreadsheet and document copies carry a rendered image beside their text; paste the text.
					if (!data.types.includes("text/plain")) {
						let images = Array.from(data.files).filter(file => file.type.startsWith("image/"));
						if (!images.length) return;
						e.preventDefault();
						return onFiles?.(images);
					}
					let area = e.currentTarget;
					let text = data.getData("text/plain").trim();
					if (area.selectionStart === area.selectionEnd || !isUrl(text)) return;
					e.preventDefault();
					link(area, text);
				}}
				{...props}
			/>
			<Popover open={!!popup}>
				<PopoverPortal>
					<PopoverPositioner anchor={el} side="top" align="start" sideOffset={4}>
						<PopoverPopup initialFocus={false} finalFocus={false}>
							{popup?.items.map((item, i) => (
								<button
									key={item.key}
									type="button"
									className={cn(
										"flex min-h-7 w-full items-center gap-2 rounded-md squircle px-2 py-1 text-xs/relaxed outline-hidden select-none",
										i === popup.index
											? "bg-accent text-accent-foreground"
											: "text-popover-foreground",
									)}
									onMouseDown={e => {
										e.preventDefault();
										accept(item);
									}}
								>
									{item.avatar && (
										<img
											className="size-5 shrink-0 rounded-full object-cover"
											src={item.avatar}
											alt=""
										/>
									)}
									<span className="truncate font-medium">{item.label}</span>
								</button>
							))}
						</PopoverPopup>
					</PopoverPositioner>
				</PopoverPortal>
			</Popover>
		</div>
	);
}

export { Editor, type Mention };
