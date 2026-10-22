import {
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { useResolvedTheme } from "@ace/ui";
import type { TerminalOpened } from "@ace/host/protocol";

import { host, onOpen } from "../host";

type Props = {
	channel: string;
	chat: number;
	active: boolean;
	/** The host's terminal from an earlier visit, to reattach to. */
	terminal?: string;
	onTerminal: (terminal: string | undefined) => void;
};

type State =
	| { status: "idle" | "connecting" | "connected" }
	| { status: "exited"; code: number }
	| { status: "error"; error: string };

const FALLBACK = {
	background: "rgb(255 255 255)",
	foreground: "rgb(31 35 40)",
	cursor: "rgb(31 35 40)",
	cursorAccent: "rgb(255 255 255)",
	selectionBackground: "rgb(83 155 245 / 0.28)",
	selectionForeground: "rgb(31 35 40)",
	selectionInactiveBackground: "rgb(83 155 245 / 0.16)",
	black: "rgb(87 96 106)",
	red: "rgb(207 34 46)",
	green: "rgb(26 127 55)",
	yellow: "rgb(154 103 0)",
	blue: "rgb(9 105 218)",
	magenta: "rgb(130 80 223)",
	cyan: "rgb(27 124 131)",
	white: "rgb(31 35 40)",
	brightBlack: "rgb(110 119 129)",
	brightRed: "rgb(164 14 38)",
	brightGreen: "rgb(17 99 41)",
	brightYellow: "rgb(99 60 1)",
	brightBlue: "rgb(33 139 255)",
	brightMagenta: "rgb(164 117 249)",
	brightCyan: "rgb(49 146 170)",
	brightWhite: "rgb(31 35 40)",
} satisfies ITheme;

let canvas: HTMLCanvasElement | undefined;

// xterm needs concrete colors, so CSS tokens (oklch, color-mix) are resolved through a canvas.
function paint(input: string, fallback: string) {
	canvas ||= document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return input || fallback;

	ctx.clearRect(0, 0, 1, 1);
	ctx.fillStyle = fallback;
	ctx.fillStyle = input || fallback;
	ctx.fillRect(0, 0, 1, 1);

	const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
	if (a === 255) return `rgb(${r} ${g} ${b})`;
	return `rgb(${r} ${g} ${b} / ${Math.round((a! / 255) * 1000) / 1000})`;
}

function tone(scheme: "light" | "dark"): ITheme {
	const style = getComputedStyle(document.documentElement);
	const token = (name: string, fallback: string) =>
		paint(style.getPropertyValue(name).trim(), fallback);
	const foreground = token("--foreground", FALLBACK.foreground);
	const muted = token("--muted-foreground", FALLBACK.brightBlack);
	const primary = token("--primary", FALLBACK.blue);
	const selection = token("--selection", FALLBACK.selectionBackground);

	return {
		...FALLBACK,
		background: token(scheme === "dark" ? "--sidebar" : "--card", FALLBACK.background),
		foreground,
		cursor: foreground,
		selectionBackground: selection,
		selectionForeground: foreground,
		selectionInactiveBackground: selection,
		black: muted,
		red: token("--destructive", FALLBACK.red),
		green: token("--success", FALLBACK.green),
		yellow: token("--warning", FALLBACK.yellow),
		blue: primary,
		magenta: token("--merged", FALLBACK.magenta),
		cyan: token("--accent-text", FALLBACK.cyan),
		white: foreground,
		brightBlack: muted,
		brightRed: token("--destructive", FALLBACK.brightRed),
		brightGreen: token("--success", FALLBACK.brightGreen),
		brightYellow: token("--warning-strong", FALLBACK.brightYellow),
		brightBlue: token("--primary-hover", FALLBACK.brightBlue),
		brightMagenta: token("--merged", FALLBACK.brightMagenta),
		brightCyan: primary,
		brightWhite: foreground,
	};
}

function bytes(data: string) {
	const text = atob(data);
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
	return out;
}

const MAC = navigator.platform.startsWith("Mac");

/** A shell in the chat's working directory, run by the host and reattached across reloads. */
export function Terminal({ channel, chat, active, terminal, onTerminal }: Props) {
	const shell = useRef<Xterm | null>(null);
	const fit = useRef<FitAddon | null>(null);
	const id = useRef(terminal);
	const restart = useRef<() => void>(undefined);
	/** Replays written to xterm and not yet parsed. */
	const replaying = useRef(0);
	const [node, setNode] = useState<HTMLDivElement | null>(null);
	const [state, setState] = useState<State>({ status: "idle" });
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const scheme = useResolvedTheme();
	const schemeRef = useRef(scheme);
	// Open lazily on first view, so restored tabs don't start shells until they're looked at.
	const [opened, setOpened] = useState(active);
	const persist = useEffectEvent(onTerminal);
	if (active && !opened) setOpened(true);

	useLayoutEffect(() => {
		schemeRef.current = scheme;
		if (shell.current) shell.current.options.theme = tone(scheme);
	}, [scheme]);

	useLayoutEffect(() => {
		if (!node) return;
		const term = new Xterm({
			cursorBlink: true,
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
			fontSize: 13,
			theme: tone(schemeRef.current),
		});
		const addon = new FitAddon();
		term.loadAddon(addon);
		term.open(node);
		addon.fit();
		shell.current = term;
		fit.current = addon;
		replaying.current = 0;

		term.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown" || event.key !== "k") return true;
			if (!(MAC ? event.metaKey : event.ctrlKey)) return true;
			// Claims the key from the window's command palette shortcut.
			event.preventDefault();
			term.clear();
			return false;
		});
		const input = term.onData((data) => {
			// xterm answers queries in replayed output (cursor position, colors) as if they were live,
			// and the shell would read those answers as typed input.
			if (replaying.current) return;
			if (!id.current) return restart.current?.();
			host.request({ op: "terminal-input", terminal: id.current, data }).catch(() => {});
		});
		const size = term.onResize(({ cols, rows }) => {
			if (!id.current) return;
			host.request({ op: "terminal-resize", terminal: id.current, cols, rows }).catch(() => {});
		});
		const observer = new ResizeObserver(() => addon.fit());
		observer.observe(node);

		return () => {
			observer.disconnect();
			input.dispose();
			size.dispose();
			term.dispose();
			shell.current = null;
			fit.current = null;
		};
	}, [node]);

	useEffect(() => {
		if (!opened || !node) return;
		let live = true;
		let off: (() => void) | undefined;

		function request(terminal: string | undefined) {
			const term = shell.current!;
			return host.request<TerminalOpened>({
				op: "terminal",
				channel,
				chat,
				...(terminal ? { terminal } : {}),
				cols: term.cols,
				rows: term.rows,
			});
		}

		async function attach() {
			if (host.status !== "open") return;
			restart.current = undefined;
			fit.current?.fit();
			setState({ status: "connecting" });
			const saved = id.current;
			let value: TerminalOpened;
			try {
				value = await request(saved).catch((error: Error) => {
					// A terminal that exited or expired on the host can't be reattached; start another.
					if (!saved || host.status !== "open") throw error;
					return request(undefined);
				});
			} catch (error) {
				if (live) setState({ status: "error", error: (error as Error).message });
				return;
			}
			if (!live) return;
			// Subscribe before yielding: output for a new terminal follows its reply on the socket.
			off?.();
			id.current = value.terminal;
			if (value.terminal !== saved) persist(value.terminal);
			const term = shell.current!;
			// The host replays recent output on reattach; clear first so it doesn't repeat.
			term.reset();
			// The saved shell is gone, such as after the host restarted; its command and output are too.
			if (saved && value.terminal !== saved) {
				term.write(
					"\x1b[2mThe host no longer had this terminal's shell, so this is a new one. The previous shell's command and output are gone.\x1b[0m\r\n",
				);
			}
			off = host.terminal(value.terminal, (frame) => {
				if ("data" in frame) {
					if (!frame.replay) return term.write(bytes(frame.data));
					replaying.current++;
					// Runs right after xterm parses the replay, before live output queued behind it.
					return term.write(bytes(frame.data), () => replaying.current--);
				}
				off?.();
				id.current = undefined;
				persist(undefined);
				restart.current = () => void attach();
				setState({ status: "exited", code: frame.exit });
			});
			setState({ status: "connected" });
		}

		void attach();
		const unwatch = onOpen(() => void attach());
		return () => {
			live = false;
			unwatch();
			off?.();
			restart.current = undefined;
		};
	}, [opened, node, channel, chat]);

	useEffect(() => {
		if (!active) return;
		const frame = requestAnimationFrame(() => shell.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [active]);

	const notice = status !== "open"
		? "Disconnected"
		: state.status === "connecting"
		? "Connecting..."
		: state.status === "error"
		? state.error
		: state.status === "exited"
		? `Exited with code ${state.code}. Press any key to restart.`
		: undefined;

	return (
		<div className="relative flex h-full min-h-0 flex-col bg-code text-foreground contain-content">
			{notice && (
				<div className="pointer-events-none absolute top-2 right-3 z-10 max-w-[calc(100%-1.5rem)] truncate rounded-md border border-border/70 bg-popover/95 px-2 py-1 text-xs text-muted-foreground shadow-popover backdrop-blur">
					{notice}
				</div>
			)}
			<div className="min-h-0 flex-1 p-3">
				<div
					ref={setNode}
					className="h-full min-h-0 overflow-hidden"
					onPointerDown={() => shell.current?.focus()}
				/>
			</div>
		</div>
	);
}
