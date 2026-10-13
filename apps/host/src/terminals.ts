import { request } from "./client";
import { log } from "./log";
import type { ChannelInfo, TerminalFrame, TerminalOpened } from "./protocol";

/** Replayed on reattach so a reopened tab shows where the shell left off. */
const SCROLLBACK = 256 * 1024;
/** A terminal nobody has watched this long is closed, as are its processes. */
const ORPHANED = 30 * 60_000;

type Listener = (frame: TerminalFrame) => void;

type Terminal = {
	id: string;
	channel: string;
	cwd: string;
	process: Bun.Subprocess;
	pty: Bun.Terminal;
	chunks: Uint8Array[];
	size: number;
	listeners: Set<Listener>;
	orphaned?: ReturnType<typeof setTimeout>;
};

const terminals = new Map<string, Terminal>();

/** Where a chat works on this host: its lane's worktree, or the project checkout. */
async function cwd(channel: string, chat: number | undefined): Promise<string> {
	const info = await request<ChannelInfo>(channel, { op: "info" });
	// Without a chat, the channel's root chat: the one no other chat owns.
	const id = chat ?? info.chats.find((value) => value.parent === undefined)?.id;
	return info.chats.find((value) => value.id === id)?.cwd || info.project;
}

function emit(terminal: Terminal, frame: TerminalFrame) {
	for (const listener of terminal.listeners) listener(frame);
}

function release(terminal: Terminal, listener: Listener) {
	terminal.listeners.delete(listener);
	if (terminal.listeners.size || terminal.orphaned) return;
	terminal.orphaned = setTimeout(() => close(terminal.id), ORPHANED);
}

/**
 * Open a terminal, or reattach to `request.terminal` while it still runs. Clients learn the id from
 * the reply, so `attach` is called after it is sent and replays the scrollback up to that point.
 */
export async function open(
	request: { channel: string; chat?: number; terminal?: string; cols: number; rows: number },
): Promise<{ opened: TerminalOpened; attach(listener: Listener): () => void }> {
	const existing = request.terminal && terminals.get(request.terminal);
	const terminal = existing || await spawn(request);
	clearTimeout(terminal.orphaned);
	terminal.orphaned = undefined;
	if (existing) existing.pty.resize(request.cols, request.rows);
	return {
		opened: { terminal: terminal.id, cwd: terminal.cwd },
		attach(listener) {
			if (terminal.size) {
				const data = Buffer.concat(terminal.chunks).toString("base64");
				listener({ terminal: terminal.id, data, replay: true });
			}
			terminal.listeners.add(listener);
			return () => release(terminal, listener);
		},
	};
}

async function spawn(
	request: { channel: string; chat?: number; cols: number; rows: number },
): Promise<Terminal> {
	const id = crypto.randomUUID();
	const dir = await cwd(request.channel, request.chat);
	const shell = process.env.SHELL || "/bin/zsh";
	let terminal!: Terminal;
	const child = Bun.spawn([shell, "-l"], {
		cwd: dir,
		env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
		terminal: {
			cols: request.cols,
			rows: request.rows,
			data(_pty, data) {
				const chunk = new Uint8Array(data);
				terminal.chunks.push(chunk);
				terminal.size += chunk.length;
				while (terminal.size > SCROLLBACK && terminal.chunks.length > 1) {
					terminal.size -= terminal.chunks.shift()!.length;
				}
				emit(terminal, { terminal: id, data: Buffer.from(chunk).toString("base64") });
			},
		},
	});
	terminal = {
		id,
		channel: request.channel,
		cwd: dir,
		process: child,
		pty: child.terminal!,
		chunks: [],
		size: 0,
		listeners: new Set(),
	};
	terminals.set(id, terminal);
	log("info", "terminal.open", {
		terminal: id,
		channel: request.channel,
		cwd: dir,
		pid: child.pid,
	});
	child.exited.then((code) => {
		log("info", "terminal.exit", { terminal: id, channel: request.channel, code });
		emit(terminal, { terminal: id, exit: code });
		clearTimeout(terminal.orphaned);
		terminals.delete(id);
	});
	return terminal;
}

export function input(id: string, data: string) {
	terminals.get(id)?.pty.write(data);
}

export function resize(id: string, cols: number, rows: number) {
	terminals.get(id)?.pty.resize(cols, rows);
}

/** Hang up the shell's process group, so commands it started go with it. */
export function close(id: string) {
	const terminal = terminals.get(id);
	if (!terminal) return;
	try {
		process.kill(-terminal.process.pid, "SIGHUP");
	} catch {
		terminal.process.kill("SIGHUP");
	}
}

/** Every terminal of a channel, when the channel is killed, archived or deleted. */
export function closeChannel(channel: string) {
	for (const terminal of terminals.values()) if (terminal.channel === channel) close(terminal.id);
}

export async function closeAll(): Promise<void> {
	const running = [...terminals.values()];
	for (const terminal of running) close(terminal.id);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.all(running.map((terminal) => terminal.process.exited)),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Some terminal shells did not exit within 10 seconds")),
					10_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
