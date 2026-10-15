const EVENTS = ["focus", "blur", "visibilitychange"];

/** For `useSyncExternalStore` with `isFocused`. */
export function subscribe(listener: () => void) {
	for (const event of EVENTS) addEventListener(event, listener);
	return () => {
		for (const event of EVENTS) removeEventListener(event, listener);
	};
}

/** The person can see this window and is using it. */
export const isFocused = () => document.visibilityState === "visible" && document.hasFocus();
