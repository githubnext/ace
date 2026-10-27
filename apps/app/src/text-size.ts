/**
 * Text size scales the whole interface through the root font size, which rem sizes follow. Page
 * zoom would also scale it, but would stop CSS pixels matching the window points that native
 * overlays such as the live view are placed in.
 */
const KEY = "ace:text-size";
const BASE = 16;
const SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24];

export const TEXT_SIZE_ACTIONS = ["text-bigger", "text-smaller", "text-reset"];

function stored(): number {
	const size = Number(localStorage.getItem(KEY));
	return SIZES.includes(size) ? size : BASE;
}

function apply(size: number) {
	document.documentElement.style.setProperty("--font-size", `${size}px`);
}

export function textSize(action: string) {
	const index = SIZES.indexOf(stored());
	const size = action === "text-bigger"
		? SIZES[Math.min(index + 1, SIZES.length - 1)]
		: action === "text-smaller"
		? SIZES[Math.max(index - 1, 0)]
		: BASE;
	if (size === BASE) localStorage.removeItem(KEY);
	else localStorage.setItem(KEY, String(size));
	apply(size);
}

apply(stored());
// Every window shares the size, so a change in one resizes the others.
window.addEventListener("storage", (event) => {
	if (event.key === KEY) apply(stored());
});
