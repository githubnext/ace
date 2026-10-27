import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { LiveStatus } from "@ace/desktop/protocol";
import { Button } from "@ace/ui";

import { desktop } from "../desktop";
import type { Content } from "../layout/storage";

/** How often a still pane asks whether its window is still there. */
const CHECK = 500;

/** Another app's window, drawn natively over this pane at its own frame rate. */
export function Live(
	{ id, window, app, active, update }: {
		id: string;
		window: number;
		app?: string;
		active: boolean;
		update: (patch: Partial<Content>) => void;
	},
) {
	const ref = useRef<HTMLElement>(null);
	const relink = useRef<{ app?: string }>(undefined);
	// After Ace restarts, only the tab knows the app, so a lost window tries it once on its own.
	const tried = useRef(false);
	const [lost, setLost] = useState(false);

	const report = useEffectEvent((status: LiveStatus | null) => {
		if (!status) return;
		if (status.state === "lost" && app && !tried.current) {
			tried.current = true;
			relink.current = { app };
			return;
		}
		setLost(status.state === "lost");
		// A relink moves the tab to the app's new window, and the app is kept for the next one.
		if (status.state !== "live") return;
		tried.current = false;
		if (status.window !== window || status.app !== app) {
			update({ window: status.window, app: status.app });
		}
	});

	useEffect(() => {
		const live = desktop?.live;
		const element = ref.current;
		if (!live || !element || !active) return;
		const send = () => {
			const request = relink.current;
			relink.current = undefined;
			live(id, window, element.getBoundingClientRect(), request).then(report).catch(() => {});
		};
		// Pane drags and window resizes move the box without a React render, so follow it per frame.
		let last = "";
		let frame = requestAnimationFrame(function follow() {
			frame = requestAnimationFrame(follow);
			const rect = element.getBoundingClientRect();
			const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
			if (key === last) return;
			last = key;
			send();
		});
		// Frames pause while Ace is covered, and a closed window must still show its relink prompt.
		const timer = setInterval(send, CHECK);
		return () => {
			cancelAnimationFrame(frame);
			clearInterval(timer);
			live(id, null).catch(() => {});
		};
	}, [id, window, active]);

	return (
		<section
			ref={ref}
			className="grid h-full min-h-0 place-items-center bg-background px-4 text-center text-sm text-muted-foreground"
		>
			{!desktop
				? "Live windows show only in Ace on the Mac running the app."
				: lost
				? (
					<div className="grid justify-items-center gap-3">
						<p>This window closed. If its app is open again, relink to its current window.</p>
						<Button type="button" variant="outline" onClick={() => (relink.current = { app })}>
							Relink
						</Button>
					</div>
				)
				: ""}
		</section>
	);
}
