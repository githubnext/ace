import { useEffect, useState } from "react";

import { Button } from "@ace/ui";
import type { CommandAction, CommandState } from "@ace/desktop/protocol";

import { desktop } from "./desktop";
import { Problem, Row, Status } from "./settings-layout";

const code = (text: string) => <code className="font-mono">{text}</code>;

function describe({ name, path, link, shell }: CommandState) {
	const dir = path.slice(0, -name.length - 1);
	if (link === "missing") return <>Run Ace from Terminal as {code(name)}</>;
	if (link === "other") return <>{path} belongs to something else</>;
	if (link === "stale") return <>{path} points to another copy of Ace</>;
	if (shell === path) return path;
	if (shell) return <>Your shell runs {shell} first</>;
	return <>{dir} isn't on your PATH</>;
}

/** The desktop app's own CLI; a browser has no app to link. */
export function CommandLine({ active }: { active: boolean }) {
	const [state, setState] = useState<{ value?: CommandState; error?: string }>({});
	const [busy, setBusy] = useState<CommandAction>();

	async function run(action: CommandAction) {
		if (!desktop) return;
		setBusy(action);
		try {
			setState({ value: await desktop.command(action) });
		} catch (error) {
			setState((last) => ({ value: last.value, error: (error as Error).message }));
		}
		setBusy(undefined);
	}

	// The person may change the link or their PATH outside Ace, so read it each time it's shown.
	useEffect(() => {
		if (active) void run("status");
	}, [active]);

	const current = state.value;
	return (
		<Row
			label="Command line tool"
			description={<span role="status">{current ? describe(current) : "Checking…"}</span>}
			footer={
				<>
					{busy === "install" && <Status>Installing…</Status>}
					{state.error && <Problem>{state.error}</Problem>}
				</>
			}
		>
			{current && current.link !== "installed" && current.link !== "other" && (
				<Button
					disabled={!!busy}
					onClick={() => void run("install")}
				>
					Install
				</Button>
			)}
			{current && (current.link === "installed" || current.link === "stale") && (
				<Button
					variant="outline"
					disabled={!!busy}
					onClick={() => void run("remove")}
				>
					Remove
				</Button>
			)}
		</Row>
	);
}
