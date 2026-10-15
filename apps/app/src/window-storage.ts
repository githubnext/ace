import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

// Each window owns its copy in sessionStorage, which survives reloads but not other windows'
// activity. The browser-profile copy in localStorage only seeds windows without one, such as new
// windows and relaunches, so it holds the most recent change made in any window.

export function load(key: string): string | null {
	return sessionStorage.getItem(key) || localStorage.getItem(key);
}

export function save(key: string, raw: string) {
	// Rewriting an unchanged copy would let a window's older state replace another window's newer
	// change in the profile copy.
	if (sessionStorage.getItem(key) === raw) return;
	sessionStorage.setItem(key, raw);
	localStorage.setItem(key, raw);
}

export function remove(key: string) {
	sessionStorage.removeItem(key);
	localStorage.removeItem(key);
}

/** State owned by this window that persists through reloads and seeds new windows. */
export function useWindowStorage<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
	const [value, setValue] = useState<T>(() => {
		const raw = load(key);
		if (raw === null) return fallback;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return fallback;
		}
	});

	useEffect(() => {
		// Saving on mount too keeps a reload from adopting another window's later profile copy.
		if (value !== undefined) save(key, JSON.stringify(value));
	}, [key, value]);

	return [value, setValue];
}
