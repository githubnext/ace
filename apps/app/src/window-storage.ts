import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

// Each window owns its copy in sessionStorage, which survives reloads but not other windows'
// activity. The browser-profile copy in localStorage only seeds windows without one, such as new
// windows and relaunches, so it holds the most recent change made in any window.

// Only keys read or written here are shared, so sessionStorage left by older versions, such as
// drafts, never replaces newer profile copies.
const owned = new Set<string>();

export function load(key: string): string | null {
	owned.add(key);
	return sessionStorage.getItem(key) || localStorage.getItem(key);
}

export function save(key: string, raw: string) {
	owned.add(key);
	// Rewriting an unchanged copy would let a window's older state replace another window's newer
	// change in the profile copy.
	if (sessionStorage.getItem(key) === raw) return;
	sessionStorage.setItem(key, raw);
	localStorage.setItem(key, raw);
}

export function remove(key: string) {
	owned.delete(key);
	sessionStorage.removeItem(key);
	localStorage.removeItem(key);
}

/** Makes this window's copies the profile copies, so a window opened from it starts where it is. */
export function share() {
	for (const key of owned) {
		const raw = sessionStorage.getItem(key);
		if (raw !== null) localStorage.setItem(key, raw);
	}
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
