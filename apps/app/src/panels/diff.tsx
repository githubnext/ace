import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { DiffView, type DiffViewFile } from "@ace/ui";
import type { Change, Changes } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import { publish, useDetails } from "../details";
import { useGit } from "../git";
import { host } from "../host";

type Props = { channel: Listing; chat: number; user: string; active: boolean };

/** A loaded patch or its failure, for the version of the file described by `stamp`. */
type Loaded = { stamp: string; patch?: string; signature?: string; error?: string };

const POLL = 2000;
// Fetching the lane's base is a network round trip, so it runs far less often than the poll.
const FETCH = 60_000;
const LIMIT = 4;
export const GROUPS = {
	committed: "Committed",
	uncommitted: "Uncommitted",
	untracked: "Untracked",
};

function group(change: Change) {
	return change.state && GROUPS[change.state];
}

/** The same identity DiffView gives a grouped file. */
function key(file: string, group: string | undefined) {
	return group ? `${group}/${file}` : file;
}

function stamp(change: Change, changes: Changes) {
	return `${changes.cwd}\0${changes.base}\0${changes.head}\0${
		change.from || ""
	}\0${change.version}\0${change.adds},${change.dels},${change.binary}`;
}

function same(a: Changes | undefined, b: Changes) {
	if (!a || a.cwd !== b.cwd || a.lane !== b.lane || a.base !== b.base || a.head !== b.head) {
		return false;
	}
	if (a.against !== b.against || a.behind !== b.behind || a.ahead !== b.ahead) return false;
	if (a.files.length !== b.files.length) return false;
	if (JSON.stringify(a.dirs) !== JSON.stringify(b.dirs)) return false;
	return a.files.every((change, i) =>
		change.file === b.files[i]!.file
		&& change.state === b.files[i]!.state
		&& stamp(change, a) === stamp(b.files[i]!, b)
	);
}

function signature(source: string) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < source.length; i++) {
		hash ^= source.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${source.length}:${(hash >>> 0).toString(36)}`;
}

function short(ref: string) {
	return /^[0-9a-f]{40}$/.test(ref)
		? ref.slice(0, 7)
		: ref.replace(/^refs\/(heads|remotes|tags)\//, "");
}

function subscribe(listener: () => void) {
	window.addEventListener("focus", listener);
	window.addEventListener("blur", listener);
	return () => {
		window.removeEventListener("focus", listener);
		window.removeEventListener("blur", listener);
	};
}

function Note({ children }: { children: string }) {
	return (
		<section className="grid h-full min-h-0 place-items-center bg-background px-4 text-center text-sm text-muted-foreground">
			{children}
		</section>
	);
}

/** The chat's changes, polled while the tab is visible and the window focused. */
export function Diff({ channel: listing, chat, user, active }: Props) {
	const channel = listing.id;
	const { pull, reveal } = useDetails(channel);
	const git = useGit(listing, chat, user);
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const focused = useSyncExternalStore(subscribe, () => document.hasFocus());
	const [changes, setChanges] = useState<Changes>();
	const [error, setError] = useState<string>();
	const [loaded, setLoaded] = useState(new Map<string, Loaded>());
	const [first, setFirst] = useState<string>();
	const [selected, setSelected] = useState<{ file?: string; key?: number }>({});
	const inflight = useRef(new Set<string>());

	useEffect(() => {
		if (!active || !focused || status !== "open") return;
		let live = true;
		let timer: ReturnType<typeof setTimeout>;
		const poll = () =>
			host.channel<Changes>(channel, { op: "changes", chat }).then(
				(next) => {
					if (!live) return;
					setChanges((current) => same(current, next) ? current : next);
					setError(undefined);
				},
				(error: Error) => {
					if (live) setError(error.message);
				},
			).finally(() => {
				if (live) timer = setTimeout(poll, POLL);
			});
		void poll();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [channel, chat, active, focused, status]);

	// A turn's file card asks for its file before this tab may have read the changes listing it.
	useEffect(() => {
		if (!reveal || reveal.chat !== chat || !changes) return;
		const change = changes.files.find((change) => change.file === reveal.file);
		if (change) setSelected({ file: key(change.file, group(change)), key: reveal.key });
		publish(channel, { reveal: null });
	}, [channel, chat, changes, reveal]);

	// Git actions read the details' changes, so a fetch's new behind count reaches them from here.
	useEffect(() => {
		if (changes) publish(channel, { changes });
	}, [channel, changes]);

	// The changes read never fetches, so Rebase could otherwise wait on something else fetching.
	useEffect(() => {
		if (!active || !focused || status !== "open") return;
		const fetch = () => void host.channel(channel, { op: "fetch", chat }).catch(() => {});
		fetch();
		const timer = setInterval(fetch, FETCH);
		return () => clearInterval(timer);
	}, [channel, chat, active, focused, status]);

	useEffect(() => {
		if (!changes || status !== "open") return;
		const wanted = changes.files.filter((change) =>
			!change.binary
			&& loaded.get(key(change.file, group(change)))?.stamp !== stamp(change, changes)
		);
		const index = wanted.findIndex((change) => key(change.file, group(change)) === first);
		if (index > 0) wanted.unshift(...wanted.splice(index, 1));

		for (const change of wanted) {
			if (inflight.current.size >= LIMIT) return;
			const id = key(change.file, group(change));
			const version = stamp(change, changes);
			const request = `${id}\0${version}`;
			if (inflight.current.has(request)) continue;
			inflight.current.add(request);
			const { file, state } = change;
			host.channel<string>(channel, { op: "patch", chat, file, ...(state ? { state } : {}) }).then(
				(patch) => ({ stamp: version, patch, signature: signature(patch) }),
				(error: Error) =>
					// A dropped connection isn't the file's failure; it reloads once reconnected.
					host.status === "open" ? { stamp: version, error: error.message } : undefined,
			).then((value) => {
				inflight.current.delete(request);
				setLoaded((current) => {
					const next = new Map(current);
					if (value) next.set(id, value);
					return next;
				});
			});
		}
	}, [channel, chat, changes, loaded, first, status]);

	const files = useMemo(
		() => {
			if (!changes) return [];
			const files = changes.files.map((change): DiffViewFile => {
				const value = loaded.get(key(change.file, group(change)));
				const current = value?.stamp === stamp(change, changes) ? value : undefined;
				return {
					group: group(change),
					file: change.file,
					from: change.from,
					binary: change.binary,
					adds: change.adds,
					dels: change.dels,
					patch: current?.patch,
					signature: current?.signature,
					error: current?.error,
					pending: !change.binary && !current,
				};
			});
			for (const { dir, files: count } of changes.dirs || []) {
				files.push({
					group: GROUPS.untracked,
					file: dir,
					adds: 0,
					dels: 0,
					note: `${count.toLocaleString()} files`,
					count,
				});
			}
			return files;
		},
		[changes, loaded],
	);

	function open(file: DiffViewFile) {
		const id = key(file.file, file.group);
		setFirst(id);
		// Reopening a file that failed retries it.
		if (!loaded.get(id)?.error) return;
		setLoaded((current) => {
			const next = new Map(current);
			next.delete(id);
			return next;
		});
	}

	if (!changes) return <Note>{error || "Loading changes…"}</Note>;

	return (
		<DiffView
			files={files}
			base={short(changes.against || changes.base)}
			head={changes.lane || short(changes.head)}
			pr={pull && !git.createPr && !git.creatingPr
				? { state: pull.state, number: String(pull.number), url: pull.url, title: pull.title }
				: undefined}
			creatingPr={git.creatingPr}
			onCreatePr={git.createPr}
			onCreateDraftPr={git.createDraftPr}
			actions={git.actions}
			onFileOpen={open}
			selected={selected.file}
			selectedKey={selected.key}
			onSelectedChange={(file) => setSelected({ file })}
			className="rounded-none border-0"
		/>
	);
}
