import { type ComponentType, Fragment, useEffect, useState, useSyncExternalStore } from "react";

import {
	Button,
	buttonVariants,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	Input,
	type Theme,
	useTheme,
} from "@ace/ui";
import {
	IconArrowDownToLine,
	IconExternal,
	IconKey,
	IconLaptop,
	IconPointer,
	type IconProps,
	IconServer,
	IconSettings,
} from "@ace/ui/icons";
import type {
	HostRequest,
	ProviderSettings,
	Settings as HostSettings,
	Subscription as Plan,
} from "@ace/host/protocol";

import { desktop } from "./desktop";
import { host } from "./host";
import { HostStatus } from "./host-settings";
import { NativeStatus } from "./native-settings";
import { Group, Problem, Row, Select, Status } from "./settings-layout";
import { UpdateSettings } from "./updates";

type Section = "general" | "providers" | "computer" | "host" | "updates";

type Info = { id: Section; label: string; description: string; icon: ComponentType<IconProps> };

const all: (Info & { desktop?: boolean })[] = [
	{
		id: "general",
		label: "General",
		description: "Appearance and the model new chats start with.",
		icon: IconSettings,
	},
	{
		id: "providers",
		label: "Providers",
		description:
			"Provider keys and subscription sign-ins stay in your system keychain. Changes apply to the next model request.",
		icon: IconKey,
	},
	{
		id: "computer",
		label: "Computer use",
		description: "Let agents see and operate apps on this Mac.",
		icon: IconPointer,
		desktop: true,
	},
	{
		id: "host",
		label: desktop ? "This Mac" : "This host",
		description: "Ace Helper, team connectivity, and tools.",
		icon: desktop ? IconLaptop : IconServer,
	},
	{
		id: "updates",
		label: "Updates",
		description: "Keep Ace and Ace Helper up to date.",
		icon: IconArrowDownToLine,
		desktop: true,
	},
];

const sections = all.filter((section) => !section.desktop || desktop);

const themes: { value: Theme; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

const sources = {
	keychain: "Saved in Keychain",
	environment: "Using an environment key",
	missing: "No key added",
	unavailable: "Keychain access needed",
};

function Provider({ provider, disabled }: { provider: ProviderSettings; disabled: boolean }) {
	const [value, setValue] = useState("");
	const [editing, setEditing] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const [action, setAction] = useState<{ busy?: boolean; error?: string; message?: string }>({});
	const id = `key-${provider.id}`;
	const locked = disabled || action.busy;

	async function run(op: "key-set" | "key-check" | "key-remove") {
		setAction({ busy: true });
		try {
			await host.request(
				op === "key-set"
					? { op, provider: provider.id, value }
					: { op, provider: provider.id },
			);
			if (op === "key-set") {
				setValue("");
				setEditing(false);
			}
			setConfirm(false);
			setAction({
				message: op === "key-check"
					? "Connection verified."
					: op === "key-remove"
					? "Saved key removed."
					: "Key checked and saved.",
			});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	return (
		<Row
			id={`${id}-label`}
			label={provider.name}
			description={
				<>
					{sources[provider.source]}
					{provider.source !== "missing" && provider.subscription?.signedIn
						&& ` · Unused while signed in with ${provider.subscription.name}`}
					{provider.override && (
						<>
							{" · "}
							{provider.override}{" "}
							takes priority over a saved key. Remove that environment override and restart Ace
							Helper to use Keychain.
						</>
					)}
				</>
			}
			footer={
				<>
					{editing && (
						<form
							className="flex flex-col gap-2 @md:flex-row"
							onSubmit={(event) => {
								event.preventDefault();
								void run("key-set");
							}}
						>
							<Input
								id={id}
								autoFocus
								type="password"
								autoComplete="new-password"
								spellCheck={false}
								aria-label={`${provider.name} API key`}
								value={value}
								maxLength={4096}
								disabled={locked}
								placeholder={provider.stored ? "Enter a replacement key" : "Paste your API key"}
								onChange={(event) => setValue(event.target.value)}
								onKeyDown={(event) => {
									if (event.key !== "Escape" || action.busy) return;
									// Escape cancels the key form before it reaches the dialog.
									event.stopPropagation();
									setEditing(false);
									setValue("");
								}}
							/>
							<div className="flex shrink-0 gap-2">
								<Button type="submit" disabled={locked || !value.trim()}>Check and save</Button>
								<Button
									type="button"
									variant="ghost"
									disabled={action.busy}
									onClick={() => {
										setEditing(false);
										setValue("");
									}}
								>
									Cancel
								</Button>
							</div>
						</form>
					)}
					{confirm && (
						<div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 @md:flex-row @md:items-center @md:justify-between">
							<p>Remove this saved key? New model requests will need another credential.</p>
							<div className="flex shrink-0 gap-2">
								<Button
									variant="destructive"
									aria-label={`Remove ${provider.name} key`}
									disabled={locked}
									onClick={() => void run("key-remove")}
								>
									Remove key
								</Button>
								<Button variant="ghost" disabled={action.busy} onClick={() => setConfirm(false)}>
									Cancel
								</Button>
							</div>
						</div>
					)}
					{provider.error && <Problem>{provider.error}</Problem>}
					{action.busy && <Status>Checking with {provider.name} or waiting for Keychain…</Status>}
					{action.error && <Problem>{action.error}</Problem>}
					{action.message && <Status>{action.message}</Status>}
				</>
			}
		>
			{(provider.source === "keychain" || provider.source === "environment") && (
				<Button
					variant="outline"
					aria-label={`Check ${provider.name} connection`}
					disabled={locked}
					onClick={() => void run("key-check")}
				>
					Check
				</Button>
			)}
			{!editing && (
				<Button
					variant="outline"
					aria-label={`${provider.stored ? "Replace" : "Add"} ${provider.name} key`}
					disabled={locked}
					onClick={() => {
						setConfirm(false);
						setEditing(true);
					}}
				>
					{provider.stored ? "Replace key" : "Add key"}
				</Button>
			)}
			{provider.stored && !confirm && (
				<Button
					variant="ghost"
					aria-label={`Remove ${provider.name} key…`}
					disabled={locked}
					onClick={() => {
						setEditing(false);
						setConfirm(true);
					}}
				>
					Remove…
				</Button>
			)}
		</Row>
	);
}

function Subscription(
	{ provider, plan, disabled }: { provider: ProviderSettings; plan: Plan; disabled: boolean },
) {
	const [value, setValue] = useState("");
	const [action, setAction] = useState<{ busy?: boolean; error?: string }>({});
	const locked = disabled || action.busy;
	const pending = plan.login && !plan.login.error;

	async function run(request: HostRequest) {
		setAction({ busy: true });
		try {
			await host.request(request);
			setValue("");
			setAction({});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	const signIn = (
		<Button
			variant="outline"
			disabled={locked}
			onClick={() => void run({ op: "login-start", provider: provider.id })}
		>
			Sign in with {plan.name}
		</Button>
	);

	return (
		<Row
			label={`${plan.name} subscription`}
			description={plan.signedIn
				? `Signed in. ${provider.name} requests use your ${plan.name} plan instead of an API key.`
				: pending
				? "Finish signing in from your browser."
				: `Use your ${plan.name} plan for ${provider.name} models instead of an API key.`}
			footer={
				<>
					{pending && (
						<form
							className="flex flex-col gap-2 @md:flex-row"
							onSubmit={(event) => {
								event.preventDefault();
								void run({ op: "login-paste", provider: provider.id, value });
							}}
						>
							<Input
								spellCheck={false}
								aria-label={`${plan.name} sign-in address`}
								value={value}
								maxLength={8192}
								disabled={locked}
								placeholder="Browser on another machine? Paste the address it ended on"
								onChange={(event) => setValue(event.target.value)}
							/>
							<Button type="submit" variant="outline" disabled={locked || !value.trim()}>
								Continue
							</Button>
						</form>
					)}
					{plan.error && <Problem>{plan.error}</Problem>}
					{plan.login?.error && <Problem>{plan.login.error}</Problem>}
					{action.error && <Problem>{action.error}</Problem>}
				</>
			}
		>
			{plan.signedIn
				? (
					<Button
						variant="ghost"
						disabled={locked}
						onClick={() => void run({ op: "logout", provider: provider.id })}
					>
						Sign out
					</Button>
				)
				: pending
				? (
					<>
						{plan.login?.url && (
							<a
								href={plan.login.url}
								target="_blank"
								rel="noopener noreferrer"
								className={buttonVariants({ variant: "outline" })}
								// WebKit skips links on Tab unless macOS keyboard navigation is on.
								tabIndex={0}
							>
								<IconExternal aria-hidden />
								Open sign-in page
							</a>
						)}
						<Button
							variant="ghost"
							disabled={action.busy}
							onClick={() => void run({ op: "login-cancel", provider: provider.id })}
						>
							Cancel
						</Button>
					</>
				)
				: signIn}
		</Row>
	);
}

function DefaultModel({ settings, disabled }: { settings?: HostSettings; disabled: boolean }) {
	const [action, setAction] = useState<{ busy?: boolean; error?: string }>({});
	const chosen = settings?.modelOverride || settings?.model;
	const value = chosen ? `${chosen.provider}/${chosen.modelId}` : "";
	const available = settings?.models.map((model) => `${model.provider}/${model.modelId}`) || [];

	async function save(value: string) {
		const split = value.indexOf("/");
		const model = value
			? { provider: value.slice(0, split), modelId: value.slice(split + 1) }
			: null;
		setAction({ busy: true });
		try {
			await host.request({ op: "preferences", model });
			setAction({});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	return (
		<Row
			id="default-model-label"
			label="Default model"
			description={settings?.modelOverride
				? "ACE_MODEL overrides this preference. Remove it and restart Ace Helper to use your saved choice."
				: "Used for a chat's first agent run. Existing chats keep their model."}
			footer={
				<>
					{action.busy && <Status>Saving default model…</Status>}
					{action.error && <Problem>{action.error}</Problem>}
				</>
			}
		>
			<Select
				aria-labelledby="default-model-label"
				className="w-60"
				value={value}
				disabled={!settings || disabled || action.busy || !!settings.modelOverride}
				onChange={(event) => void save(event.target.value)}
			>
				<option value="">{settings ? "Automatic" : "Loading…"}</option>
				{value && !available.includes(value) && (
					<option value={value} disabled>{value} (unavailable)</option>
				)}
				{available.map((model) => <option key={model} value={model}>{model}</option>)}
			</Select>
		</Row>
	);
}

function Appearance() {
	const { theme, set } = useTheme();
	return (
		<Row
			id="theme-label"
			label="Theme"
			description="Match your system appearance or keep Ace light or dark."
		>
			<Select
				aria-labelledby="theme-label"
				value={theme}
				onChange={(event) => set(event.target.value as Theme)}
			>
				{themes.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
			</Select>
		</Row>
	);
}

export function Settings(
	{ onClose, initialSection }: { onClose: () => void; initialSection?: "updates" },
) {
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const [section, setSection] = useState<Section>(
		// Updates exist only in the desktop app; browsers keep their usual first section.
		(desktop && initialSection) || (status === "open" ? "general" : "host"),
	);
	// Sections stay mounted after their first visit so in-flight key, helper, and update actions
	// keep their busy state and results; hidden sections stop their own polling.
	const [visited, setVisited] = useState(() => new Set([section]));
	const version = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	const [retry, setRetry] = useState(0);
	const [result, setResult] = useState<{ settings?: HostSettings; error?: string }>({});
	const offline = status !== "open";
	const current = sections.find(({ id }) => id === section)!;

	function show(next: Section) {
		setSection(next);
		setVisited((seen) => seen.has(next) ? seen : new Set(seen).add(next));
	}

	useEffect(() => {
		if (!desktop) return;
		const updates = () => show("updates");
		window.addEventListener("ace:updates", updates);
		return () => window.removeEventListener("ace:updates", updates);
	}, []);

	// Reading provider settings touches Keychain, so pages that don't show it never request it.
	const needed = visited.has("general") || visited.has("providers");
	useEffect(() => {
		if (status !== "open" || !needed) return;
		let active = true;
		host.request<HostSettings>({ op: "settings" }).then(
			(settings) => {
				if (active) setResult({ settings });
			},
			(error: Error) => {
				// Keep the last snapshot so mounted provider rows keep their drafts and busy state.
				if (active) setResult((last) => ({ settings: last.settings, error: error.message }));
			},
		);
		return () => {
			active = false;
		};
	}, [status, version, retry, needed]);

	const reading = !result.settings && !result.error && !offline;
	const refresh = (label: string) => (
		<Button
			variant="ghost"
			size="sm"
			disabled={offline}
			onClick={() => setRetry((value) => value + 1)}
		>
			{label}
		</Button>
	);
	const problems = (
		<>
			{offline && <Status>Waiting for Ace Helper to reconnect…</Status>}
			{reading && <Status>Reading provider settings…</Status>}
			{result.error && <Problem>{result.error}</Problem>}
			{result.settings?.error && <Problem>{result.settings.error}</Problem>}
		</>
	);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="grid h-[min(40rem,var(--dialog-max))] w-[min(56rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-none sm:grid-cols-[11.5rem_minmax(0,1fr)] sm:grid-rows-1">
				<div className="flex min-w-0 flex-col gap-3 border-b border-border/60 bg-muted/40 p-3 sm:border-r sm:border-b-0">
					<DialogTitle className="px-2 pt-1">Settings</DialogTitle>
					<nav aria-label="Settings sections">
						<ul className="flex gap-0.5 overflow-x-auto scrollbar-hidden sm:flex-col">
							{sections.map(({ id, label, icon: Icon }) => (
								<li key={id} className="shrink-0">
									<button
										type="button"
										aria-current={section === id ? "page" : undefined}
										onClick={() => show(id)}
										className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors duration-100 hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-[current=page]:bg-foreground/[0.07] aria-[current=page]:text-foreground motion-reduce:transition-none"
									>
										<Icon className="size-3.5 shrink-0" aria-hidden />
										{label}
									</button>
								</li>
							))}
						</ul>
					</nav>
				</div>
				<div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
					<header className="flex flex-col gap-1 py-4 pr-12 pl-6">
						<h2 className="text-sm font-medium">{current.label}</h2>
						<DialogDescription>{current.description}</DialogDescription>
					</header>
					<div className="@container min-h-0 overflow-y-auto overscroll-contain px-6 pb-6">
						{visited.has("general") && (
							<div hidden={section !== "general"} className="flex flex-col gap-6">
								<Group title="Appearance">
									<Appearance />
								</Group>
								<Group title="Models">
									<DefaultModel settings={result.settings} disabled={offline} />
								</Group>
								{problems}
								{result.error && <div>{refresh("Try again")}</div>}
							</div>
						)}
						{visited.has("providers") && (
							<div hidden={section !== "providers"} className="flex flex-col gap-3">
								{result.settings && (
									<Group>
										{result.settings.providers.map((provider) => (
											<Fragment key={provider.id}>
												<Provider provider={provider} disabled={offline} />
												{provider.subscription && (
													<Subscription
														provider={provider}
														plan={provider.subscription}
														disabled={offline}
													/>
												)}
											</Fragment>
										))}
									</Group>
								)}
								{problems}
								{/* Keychain unlocks and environment changes happen outside Ace. */}
								<div className="flex justify-end">{refresh("Refresh settings")}</div>
							</div>
						)}
						{desktop && visited.has("computer") && (
							<div hidden={section !== "computer"}>
								<NativeStatus native={desktop.native} active={section === "computer"} />
							</div>
						)}
						{visited.has("host") && (
							<div hidden={section !== "host"}>
								<HostStatus active={section === "host"} />
							</div>
						)}
						{desktop && visited.has("updates") && (
							<div hidden={section !== "updates"}>
								<UpdateSettings />
							</div>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
