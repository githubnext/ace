import { useEffect, useEffectEvent, useRef, useState } from "react";
import data from "@emoji-mart/data";
import { Picker } from "emoji-mart";

import { emojiCategoryIcons } from "../icons";
import { CUSTOM, type Emoji } from "../lib/emoji";
import { useResolvedTheme } from "../components/theme";

type Props = {
	/** Called when an emoji is selected. */
	onSelect?: (emoji: Emoji) => void;
	/** Override resolved theme. Falls back to `useResolvedTheme`. */
	theme?: "light" | "dark";
};

const TONES = [
	{ emoji: "👋", label: "Default skin tone" },
	{ emoji: "👋🏻", label: "Light skin tone" },
	{ emoji: "👋🏼", label: "Medium-light skin tone" },
	{ emoji: "👋🏽", label: "Medium skin tone" },
	{ emoji: "👋🏾", label: "Medium-dark skin tone" },
	{ emoji: "👋🏿", label: "Dark skin tone" },
] as const;

/**
 * Paints CSS colors over each other into an "R, G, B" triplet for emoji-mart's --rgb-* vars, which
 * take no alpha: a translucent token alone would read as its opaque base color.
 */
function toRGB(...colors: string[]) {
	let ctx = document.createElement("canvas").getContext("2d")!;
	for (let color of colors) {
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 1, 1);
	}
	let [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
	return `${r}, ${g}, ${b}`;
}

/** Reads design tokens from the DOM and maps them to emoji-mart CSS vars. */
function resolveVars(el: HTMLElement) {
	let s = getComputedStyle(el);
	let get = (name: string) => s.getPropertyValue(name).trim();
	return {
		"--rgb-background": toRGB(get("--popover")),
		"--rgb-input": toRGB(get("--popover"), get("--input")),
		"--rgb-color": toRGB(get("--popover-foreground")),
		"--rgb-accent": toRGB(get("--accent")),
		"--color-border": get("--border"),
		"--color-border-over": get("--border"),
		"--font-size": "11px",
		"--padding": "8px",
		"--padding-small": "4px",
		"--border-radius": "0px",
	} as Record<string, string>;
}

const ACE_SVG = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
	<path d="M12.4631 6.03748C12.5688 6.21621 12.57 6.43802 12.4661 6.61784L7.37847 15.9293C7.27571 16.1073 7.08581 16.2169 6.88029 16.2169H3.57611C3.13328 16.2169 2.85651 15.7376 3.07793 15.3541L10.0451 3.2876C10.2652 2.90643 10.8144 2.90358 11.0384 3.28245L12.4631 6.03748Z" stroke="currentColor" stroke-width="2"/>
	<path d="M17.5653 15.3488C17.792 15.7322 17.5156 16.2168 17.0701 16.2168H13.7394C13.536 16.2168 13.3477 16.1094 13.2442 15.9343L11.0956 12.3007C10.8689 11.9173 11.1453 11.4327 11.5908 11.4327H14.9215C15.1249 11.4327 15.3132 11.5401 15.4167 11.7152L17.5653 15.3488Z" stroke="currentColor" stroke-width="2"/>
</svg>`;

const ICONS: Record<string, { svg: string }> = {
	...Object.fromEntries(Object.entries(emojiCategoryIcons).map(([id, svg]) => [id, { svg }])),
	ace: { svg: ACE_SVG },
};

const HOVER_BG = "color-mix(in oklch, var(--accent) 15%, transparent)";

function shadowCSS() {
	return `
	* { corner-shape: squircle; }
	#nav { padding: 6px 8px; }
	#nav .bar { bottom: -6px; }
	#nav > .flex { gap: 2px; }
	#nav button { flex-grow: 0; padding: 2px 4px; color: var(--muted-foreground); }
	#nav button[aria-selected="true"] { color: var(--accent); }
	#nav svg { fill: none; }
	#nav svg, #nav img { width: 20px; height: 20px; }
	#root .search input { border-radius: 8px; padding-block: 4px; font-size: 13px; }
	#root .search { margin-block-end: 4px; }
	.category .sticky { font-size: 13px; padding-block: 4px; }
	.category button .background { background-color: ${HOVER_BG}; }
`;
}

/** Emoji picker styled to match the design system. */
function EmojiPicker({ onSelect, theme }: Props) {
	let root = useRef<HTMLDivElement>(null);
	let mount = useRef<HTMLDivElement>(null);
	let picker = useRef<InstanceType<typeof Picker> | null>(null);
	let select = useEffectEvent((emoji: Emoji) => onSelect?.(emoji));
	let fallback = useResolvedTheme();
	let resolved = theme || fallback;
	let [skin, setSkin] = useState(1);
	let initial = useEffectEvent(() => ({ theme: resolved, skin }));

	useEffect(() => {
		let el = mount.current;
		if (!el) return;

		let instance = new Picker({
			data,
			ref: { current: el },
			...initial(),
			perLine: 6,
			emojiSize: 18,
			emojiButtonSize: 28,
			emojiButtonRadius: "12px",
			previewPosition: "none",
			skinTonePosition: "none",
			maxFrequentRows: 1,
			set: "native",
			dynamicWidth: true,
			categoryIcons: ICONS,
			custom: CUSTOM,
			onEmojiSelect: (e: Emoji) => select(e),
		});

		let host = el.querySelector("em-emoji-picker");
		if (host?.shadowRoot) {
			let s = document.createElement("style");
			s.textContent = shadowCSS();
			host.shadowRoot.appendChild(s);
		}
		// emoji-mart's autoFocus runs before the popover can take focus, so focus search a frame later.
		let frame = requestAnimationFrame(() => host?.shadowRoot?.querySelector("input")?.focus());
		picker.current = instance;
		applyVars();

		return () => {
			cancelAnimationFrame(frame);
			picker.current = null;
			el.replaceChildren();
		};
	}, []);

	function applyVars() {
		let el = root.current;
		let host = el?.querySelector("em-emoji-picker") as HTMLElement | null;
		if (!el || !host) return;
		let vars = resolveVars(el);
		for (let [k, v] of Object.entries(vars)) host.style.setProperty(k, v);
	}

	useEffect(() => {
		picker.current?.update({ skin, theme: resolved });
		applyVars();
	}, [skin, resolved]);

	return (
		<div
			ref={root}
			className="bg-popover [&_em-emoji-picker]:rounded-none [&_em-emoji-picker]:border-none [&_em-emoji-picker]:shadow-none [&_em-emoji-picker]:bg-transparent"
		>
			<div ref={mount} />
			<div className="flex items-center gap-0.5 bg-popover px-2 py-1.5 text-popover-foreground">
				<span className="mr-1 text-[10px] text-muted-foreground">Skin Tone</span>
				{TONES.map((tone, i) => (
					<button
						key={tone.emoji}
						type="button"
						aria-label={tone.label}
						aria-pressed={skin === i + 1}
						onClick={() => setSkin(i + 1)}
						className={`flex size-7 cursor-pointer items-center justify-center rounded-[6px] squircle text-[18px] leading-none ${
							skin === i + 1 ? "bg-[var(--hover-bg)]" : "hover:bg-[var(--hover-bg)]"
						}`}
						style={{ "--hover-bg": HOVER_BG } as React.CSSProperties}
					>
						{tone.emoji}
					</button>
				))}
			</div>
		</div>
	);
}

export { type Emoji, EmojiPicker };
