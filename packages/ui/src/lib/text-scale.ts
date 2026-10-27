import { useSyncExternalStore } from "react";

/** The root font size against the 16px default, which the app's text size setting changes. */
function measure(): number {
	return parseFloat(getComputedStyle(document.documentElement).fontSize) / 16;
}

let scale: number | undefined;

function subscribe(change: () => void) {
	let observer = new MutationObserver(() => {
		scale = measure();
		change();
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
	return () => observer.disconnect();
}

/**
 * For layouts measured in fixed pixels, such as timeline text, which rem-based sizing doesn't
 * reach.
 */
export function useTextScale(): number {
	return useSyncExternalStore(subscribe, () => scale ??= measure(), () => 1);
}
