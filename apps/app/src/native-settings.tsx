import { useEffect, useState } from "react";

import { Button } from "@ace/ui";
import { IconCheck } from "@ace/ui/icons";
import type { NativeAction, NativeState } from "@ace/desktop/protocol";

import { Group, Page, Problem, Row, Value } from "./settings-layout";

type Permission = Extract<NativeAction, { op: "permission" }>["permission"];

const permissions = [
	{
		key: "accessibility",
		label: "Accessibility",
		description: "Read and operate controls in other apps",
	},
	{
		key: "screenRecording",
		label: "Screen Recording",
		description: "See window contents in screenshots",
	},
	{
		key: "eventSynthesizing",
		label: "Keyboard input",
		description: "Type and press shortcuts in other apps",
	},
] as const;

const clipboardPolicies: Record<NativeState["clipboardRead"]["policy"], string> = {
	default: "macOS default",
	ask: "Ask",
	always_allow: "Always allow",
	always_deny: "Always deny",
	unavailable_on_this_os: "No macOS grant required",
	unknown: "Unknown",
};

const states: Record<NativeState["state"], string> = {
	stopped: "Not running",
	starting: "Starting…",
	ready: "Ready",
	stopping: "Stopping…",
	error: "Needs attention",
};

export function NativeStatus(
	{ native, active }: { native: (action: NativeAction) => Promise<NativeState>; active: boolean },
) {
	const [result, setResult] = useState<{ value?: NativeState; error?: string }>({});
	const [action, setAction] = useState<{ busy?: Permission; error?: string }>({});
	const [retry, setRetry] = useState(0);

	useEffect(() => {
		if (!active) return;
		let live = true;
		let pending = false;
		const check = () => {
			if (document.visibilityState !== "visible" || pending) return;
			pending = true;
			native({ op: "status" }).then(
				(value) => {
					if (live) setResult({ value });
				},
				(error: Error) => {
					if (live) setResult({ error: error.message });
				},
			).finally(() => {
				pending = false;
			});
		};
		check();
		// macOS grants change in System Settings, so refresh while this section is on screen.
		const timer = window.setInterval(check, 3000);
		window.addEventListener("focus", check);
		document.addEventListener("visibilitychange", check);
		return () => {
			live = false;
			window.clearInterval(timer);
			window.removeEventListener("focus", check);
			document.removeEventListener("visibilitychange", check);
		};
	}, [native, active, retry]);

	async function grant(permission: Permission) {
		setAction({ busy: permission });
		try {
			const value = await native({ op: "permission", permission });
			setResult({ value });
			setAction(value.error ? { error: value.error } : {});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
		setRetry(value => value + 1);
	}

	const value = result.value;
	const needsPermission = value?.state === "ready"
		&& (permissions.some(({ key }) => !value[key]) || !value.clipboardRead.readAdmitted);
	const error = action.error || result.error || value?.error;

	return (
		<Page>
			<Group>
				<Row
					label="Status"
					description="Agents can use this Mac while Ace is open"
					footer={error && <Problem>{error}</Problem>}
				>
					<Value>
						{needsPermission
							? "Permissions needed"
							: value
							? states[value.state]
							: result.error
							? "Couldn't check"
							: "Checking…"}
					</Value>
				</Row>
			</Group>
			<Group title="macOS permissions">
				{permissions.map(({ key, label, description }) => (
					<Row key={key} label={label} description={description}>
						{!value
							? <Value>Not checked</Value>
							: value[key]
							? (
								<span className="flex items-center gap-1 text-xs text-muted-foreground">
									<IconCheck className="size-3.5" aria-hidden />
									Granted
								</span>
							)
							: (
								<Button
									variant="outline"
									aria-label={`Enable ${label}`}
									disabled={!!action.busy}
									onClick={() => void grant(key)}
								>
									{action.busy === key ? "Requesting…" : "Enable…"}
								</Button>
							)}
					</Row>
				))}
				<Row
					label="Clipboard"
					description={value && !value.clipboardRead.readAdmitted
						? "Allow in System Settings to insert text without losing the clipboard"
						: "Insert text without losing the clipboard"}
				>
					<Value>{value ? clipboardPolicies[value.clipboardRead.policy] : "Not checked"}</Value>
				</Row>
			</Group>
		</Page>
	);
}
