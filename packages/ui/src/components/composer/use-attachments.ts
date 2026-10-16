import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Attachment } from "./attachment-list";

/** Own only the preview URLs created by this composer, for its attachment lifetime. */
export function useAttachments(
	value: Attachment[] | undefined,
	onChange?: (next: Attachment[]) => void,
) {
	let [state, setState] = useState<Attachment[]>([]);
	let current = value ?? state;
	let ref = useRef(current);
	let latest = useRef({ onChange });
	let [owned] = useState(() => new Map<string, () => void>());

	// Reconcile after every commit, including a parent's rejected controlled update.
	useLayoutEffect(() => {
		ref.current = current;
		latest.current = { onChange };
		let live = new Set(current.map(item => item.preview));
		for (let [url, dispose] of owned) {
			if (live.has(url)) continue;
			dispose();
			owned.delete(url);
		}
	});

	useEffect(() => () => {
		for (let dispose of owned.values()) dispose();
		owned.clear();
	}, [owned]);

	function update(next: Attachment[]) {
		ref.current = next;
		// Also commit controlled requests so rejected additions release their URLs.
		setState(next);
		latest.current.onChange?.(next);
	}

	function add(files: File[]) {
		let items = files.map(file => {
			let preview: string | undefined;
			if (file.type.startsWith("image/")) {
				// The ownership map disposes this exact URL on removal, rejected updates, and unmount.
				let url = URL.createObjectURL(file);
				owned.set(url, () => URL.revokeObjectURL(url));
				preview = url;
			}
			return {
				// randomUUID needs a secure context; a host's own app can be served over plain HTTP.
				id: Array.from(
					crypto.getRandomValues(new Uint8Array(12)),
					(byte) => byte.toString(16).padStart(2, "0"),
				).join(""),
				name: file.name,
				type: file.type,
				size: file.size,
				preview,
				file,
			};
		});
		update([...ref.current, ...items]);
	}

	function remove(id: string) {
		update(ref.current.filter(item => item.id !== id));
	}

	function reset() {
		if (ref.current.length) update([]);
	}

	return { current, ref, add, remove, reset };
}
