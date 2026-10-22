/**
 * Asking to join over the tailnet. A host that isn't in a team asks a teammate's host, and that
 * host's owner approves in their app; the directory URL and secret then go to the asking host over
 * WireGuard, so nobody sends them by hand. Tailscale names who is asking, and only this host's
 * owner, from its local app, can approve.
 */
import type { Invite, TeamAsk } from "./protocol";
import { invite } from "./settings";

/** Long enough to notice the prompt; an unanswered ask then fails instead of waiting forever. */
const EXPIRES = 5 * 60_000;

type Waiting = {
	ask: TeamAsk;
	/** The asking peer's socket, so an ask ends with its connection. */
	from: object;
	resolve: (value: Invite) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

const waiting = new Map<string, Waiting>();

export function list(): TeamAsk[] {
	return [...waiting.values()].map(({ ask }) => ask);
}

function end(id: string, changed: () => void) {
	const entry = waiting.get(id);
	if (!entry) return;
	clearTimeout(entry.timer);
	waiting.delete(id);
	changed();
	return entry;
}

/** Waits for the owner's answer; asking again from the same machine replaces the earlier ask. */
export async function ask(
	from: object,
	person: { login: string; host: string; github?: string },
	changed: () => void,
): Promise<Invite> {
	// Refuse before prompting anyone when there is nothing to hand over.
	await invite();
	for (const { ask } of waiting.values()) {
		if (ask.login === person.login && ask.host === person.host) {
			end(ask.id, changed)?.reject(new Error("Asked again"));
		}
	}
	const id = crypto.randomUUID();
	const expires = Date.now() + EXPIRES;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			end(id, changed)?.reject(
				new Error("Nobody answered in time. Ask again when they're around."),
			);
		}, EXPIRES);
		waiting.set(id, { ask: { id, ...person, expires }, from, resolve, reject, timer });
		changed();
	});
}

export async function answer(id: string, approve: boolean, changed: () => void): Promise<void> {
	const entry = waiting.get(id);
	if (!entry) throw new Error("That request has ended");
	if (!approve) {
		end(id, changed);
		return entry.reject(new Error("They declined. Ask them for an invite link instead."));
	}
	const team = await invite();
	end(id, changed);
	entry.resolve(team);
}

/** A peer that disconnects can't receive an approval. */
export function drop(from: object, changed: () => void): void {
	for (const entry of waiting.values()) {
		if (entry.from === from) end(entry.ask.id, changed)?.reject(new Error("Disconnected"));
	}
}
