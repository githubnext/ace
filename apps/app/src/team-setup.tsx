import { type ReactNode, useId, useState } from "react";

import {
	Button,
	buttonVariants,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Switch,
} from "@ace/ui";
import { IconArrowUpRight, IconCheck, IconCopy, IconLoader } from "@ace/ui/icons";

import { host } from "./host";
import { useDiagnostics } from "./host-settings";

const DOCS = "https://github.com/githubnext/ace/blob/main/docs/setup.md";
const PROVIDERS = {
	cloudflare: { label: "Cloudflare" },
	fly: { label: "Fly.io" },
};

// Names, URLs, and secrets are typed exactly; macOS would otherwise capitalize and correct them.
const RAW = { autoCorrect: "off", autoCapitalize: "off", spellCheck: false } as const;

type Provider = keyof typeof PROVIDERS;
type Step = "fork" | "join" | "directory" | "remote" | "setup" | "invite" | "solo";
const STEPS: Partial<Record<Step, string>> = {
	directory: "Directory",
	remote: "Remote channels",
	setup: "Set up",
	invite: "Invite",
};

/**
 * First-run setup for the first person on a tailnet, or a way into the team for everyone after.
 * Membership stays the tailnet's: this only decides where the team's channels are listed.
 */
export function TeamSetup({ github, onClose }: { github?: string; onClose: () => void }) {
	const [step, setStep] = useState<Step>("fork");
	const [starting, setStarting] = useState(true);
	const [listed, setListed] = useState<"hosted" | "peers">("hosted");
	const [provider, setProvider] = useState<Provider>("cloudflare");
	const [hosted, setHosted] = useState(false);
	const [joined, setJoined] = useState<{ url: string; secret: string }>();

	return (
		<Dialog open onOpenChange={next => next || onClose()}>
			<DialogContent className="gap-4 sm:max-w-[34rem]">
				{STEPS[step] && <Steps current={step} />}
				{step === "fork" && (
					<>
						<Checks github={github} />
						<Header
							title="Set up Ace for your team"
							description="Everyone on your tailnet is your team. Start with how they'll find each other's channels."
						/>
						<div role="radiogroup" className="flex flex-col gap-2">
							<Choice
								selected={starting}
								onSelect={() => setStarting(true)}
								title="Get your team started"
							>
								You're the first on this tailnet. Pick where the team's channels are listed. You can
								change it later.
							</Choice>
							<Choice
								selected={!starting}
								onSelect={() => setStarting(false)}
								title="Join your team"
							>
								Someone already set Ace up. Use the directory URL and team secret they sent you.
							</Choice>
						</div>
						<Footer
							back={<Button variant="ghost" onClick={onClose}>Just me for now</Button>}
							next={
								<Button onClick={() => setStep(starting ? "directory" : "join")}>Continue</Button>
							}
						/>
					</>
				)}
				{step === "join" && (
					<>
						<Header
							title="Join your team"
							description="Enter the directory URL and team secret your teammate sent you."
						/>
						<Join onJoined={onClose} back={() => setStep("fork")} />
					</>
				)}
				{step === "directory" && (
					<>
						<Header
							title="Where should your team's channels be listed?"
							description="A directory lists every channel, so they stay visible while their Mac sleeps, and lets you share projects and see who's here."
						/>
						<div role="radiogroup" className="flex flex-col gap-2">
							<Choice
								selected={listed === "hosted"}
								onSelect={() => setListed("hosted")}
								title={
									<>
										Hosted directory <Pill recommended>Recommended</Pill>
									</>
								}
							>
								Runs in your own cloud account.
								<div className="mt-2 flex gap-1.5">
									{(Object.keys(PROVIDERS) as Provider[]).map(id => (
										<Button
											key={id}
											size="sm"
											variant="outline"
											aria-pressed={listed === "hosted" && provider === id}
											className={`border ${
												listed === "hosted" && provider === id ? "border-primary text-primary" : ""
											}`}
											onClick={(event) => {
												event.stopPropagation();
												setListed("hosted");
												setProvider(id);
											}}
										>
											{PROVIDERS[id].label}
										</Button>
									))}
								</div>
							</Choice>
							<Choice
								selected={listed === "peers"}
								onSelect={() => setListed("peers")}
								title="Peer to peer only"
							>
								Nothing to deploy. Teammates on the tailnet see your channels only while your Mac is
								awake, with no shared projects, presence, or remote channels.
							</Choice>
						</div>
						<Footer
							back={
								<>
									<Button variant="ghost" onClick={() => setStep("fork")}>Back</Button>
									<a
										href={`${DOCS}#on-celld`}
										target="_blank"
										rel="noopener noreferrer"
										className={buttonVariants({ variant: "link" })}
									>
										Host myself <IconArrowUpRight aria-hidden data-icon="inline-end" />
									</a>
								</>
							}
							next={
								<Button onClick={() => setStep(listed === "hosted" ? "remote" : "solo")}>
									Continue
								</Button>
							}
						/>
					</>
				)}
				{step === "remote" && (
					<>
						<Header
							title="Allow channels that run off your Mac"
							description="Channels run on your Mac by default. Turn on what your team may move elsewhere, now or later."
						/>
						<div className="flex flex-col gap-2">
							<Toggle
								checked={hosted}
								onChange={setHosted}
								title="Hosted channels"
								description={`Chat keeps going while your Mac sleeps; tools still run on it. Adds a channel service on ${
									PROVIDERS[provider].label
								}.`}
							/>
							<Toggle
								checked={false}
								disabled
								title={
									<>
										Cloud workspaces <Pill>Soon</Pill>
									</>
								}
								description="Chat and tools run in containers from a fresh clone, billed per container minute."
							/>
						</div>
						<Footer
							back={<Button variant="ghost" onClick={() => setStep("directory")}>Back</Button>}
							next={<Button onClick={() => setStep("setup")}>Continue</Button>}
						/>
					</>
				)}
				{step === "setup" && (
					<Setup
						provider={provider}
						hosted={hosted}
						back={() => setStep("remote")}
						onJoined={(url, secret) => {
							setJoined({ url, secret });
							setStep("invite");
						}}
					/>
				)}
				{step === "invite" && joined && (
					<>
						<Header title="Your team is ready" description="Send teammates these steps." />
						<Invite>
							<li>
								Download Ace from <Link href="https://ace.githubnext.com">ace.githubnext.com</Link>
							</li>
							<li>
								Get on your tailnet:{" "}
								<Link href="https://login.tailscale.com/admin/users">invite them in Tailscale</Link>
							</li>
							<li>
								Join with the directory URL and team secret
								<div className="mt-2 flex flex-col gap-1.5">
									<Copyable value={joined.url} />
									<Copyable value={joined.secret} secret />
								</div>
							</li>
						</Invite>
						<p className="rounded-md bg-muted px-3 py-2 text-xs leading-5">
							<b className="font-medium">Send them privately.</b>{" "}
							Anyone with both can read every channel's name and summary and post in hosted
							channels.
						</p>
						<Footer next={<Button onClick={onClose}>Done</Button>} />
					</>
				)}
				{step === "solo" && (
					<>
						<Header
							title="Your team is ready"
							description="Teammates just need to be on your tailnet and run Ace. They'll see your channels while your Mac is awake."
						/>
						<Invite>
							<li>
								Download Ace from <Link href="https://ace.githubnext.com">ace.githubnext.com</Link>
							</li>
							<li>
								Get on your tailnet:{" "}
								<Link href="https://login.tailscale.com/admin/users">invite them in Tailscale</Link>
							</li>
						</Invite>
						<Footer
							back={
								<Button variant="ghost" onClick={() => setStep("directory")}>
									Add a directory
								</Button>
							}
							next={<Button onClick={onClose}>Done</Button>}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function Setup({ provider, hosted, back, onJoined }: {
	provider: Provider;
	hosted: boolean;
	back: () => void;
	onJoined: (url: string, secret: string) => void;
}) {
	const command = `bun services/deploy.ts ${provider}${hosted ? " --hosted" : ""}`;
	// Ace deploys Cloudflare's bundled services itself; Fly.io still needs a checkout and flyctl.
	if (provider === "cloudflare") {
		return <Deploy hosted={hosted} command={command} back={back} onJoined={onJoined} />;
	}
	return (
		<>
			<Header
				title="Deploy to Fly.io"
				description={
					<>
						Ace deploys to Cloudflare for you. For Fly.io, run this from an Ace checkout signed in
						to <code>fly</code>, then enter what it prints.
					</>
				}
			/>
			<Copyable value={command} />
			<Join onJoined={onJoined} back={back} />
		</>
	);
}

function Deploy({ hosted, command, back, onJoined }: {
	hosted: boolean;
	command: string;
	back: () => void;
	onJoined: (url: string, secret: string) => void;
}) {
	const [waiting, setWaiting] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [commands, setCommands] = useState(false);
	const stages = [
		{ label: "Sign in to Cloudflare", from: "Checking your Cloudflare" },
		...hosted ? [{ label: "Deploy hosted channels", from: "Deploying hosted" }] : [],
		{ label: "Deploy the directory", from: "Deploying the directory" },
		{ label: "Join this Mac", from: "Joining" },
	];
	const [stage, setStage] = useState(-1);

	async function deploy() {
		setBusy(true);
		setError("");
		setStage(0);
		try {
			const { url, secret } = await host.deployTeam(hosted, (text) => {
				setWaiting(text);
				const next = stages.findIndex(({ from }) => text?.startsWith(from));
				if (next >= 0) setStage(next);
			});
			onJoined(url, secret);
		} catch (error) {
			setError((error as Error).message);
		} finally {
			setBusy(false);
			setWaiting(null);
		}
	}

	return (
		<>
			<Header
				title="Deploy to Cloudflare"
				description="Ace deploys your tailnet's services to your Cloudflare account, makes a new team secret, and joins this Mac. You'll sign in to Cloudflare in your browser if you haven't before."
			/>
			<ol className="flex flex-col gap-1.5 text-sm">
				{stages.map(({ label }, index) => (
					<li key={label} className="flex items-center gap-2">
						{index < stage
							? <IconCheck className="size-3.5 text-primary" aria-hidden />
							: index === stage && busy
							? <IconLoader className="size-3.5 animate-spin" aria-hidden />
							: <span className="size-3.5 text-center text-muted-foreground">·</span>}
						<span
							className={index > stage || (index === stage && !busy)
								? "text-muted-foreground"
								: ""}
						>
							{index === stage && waiting || label}
						</span>
					</li>
				))}
			</ol>
			{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
			{commands && <Copyable value={command} />}
			<Footer
				back={
					<>
						<Button variant="ghost" disabled={busy} onClick={back}>Back</Button>
						<Button variant="link" onClick={() => setCommands(!commands)}>
							{commands ? "Hide the command" : "Show the command"}
						</Button>
					</>
				}
				next={
					<Button disabled={busy} onClick={() => void deploy()}>
						{busy ? "Deploying…" : error ? "Try again" : "Deploy"}
					</Button>
				}
			/>
		</>
	);
}

/** Today's Settings → Team join: the directory checks the secret before either is saved. */
function Join(
	{ onJoined, back }: { onJoined: (url: string, secret: string) => void; back: () => void },
) {
	const id = useId();
	const [url, setUrl] = useState("");
	const [secret, setSecret] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function join() {
		setBusy(true);
		setError("");
		try {
			await host.request({ op: "directory-set", url, secret });
			onJoined(url.trim(), secret.trim());
		} catch (error) {
			setError((error as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<form
				id={id}
				className="flex flex-col gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void join();
				}}
			>
				<Input
					{...RAW}
					type="url"
					aria-label="Directory URL"
					placeholder="Directory URL"
					value={url}
					disabled={busy}
					onChange={(event) => setUrl(event.target.value)}
				/>
				<Input
					{...RAW}
					type="password"
					autoComplete="new-password"
					aria-label="Team secret"
					placeholder="Team secret"
					value={secret}
					disabled={busy}
					onChange={(event) => setSecret(event.target.value)}
				/>
				{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
			</form>
			<Footer
				back={<Button variant="ghost" disabled={busy} onClick={back}>Back</Button>}
				next={
					<Button type="submit" form={id} disabled={busy || !url.trim() || !secret.trim()}>
						{busy ? "Checking…" : "Check and join"}
					</Button>
				}
			/>
		</>
	);
}

function Checks({ github }: { github?: string }) {
	const { value } = useDiagnostics(true);
	const tailscale = value?.tailscale;
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
			<Check ok={tailscale?.state === "running"}>
				Tailscale {tailscale?.state === "running"
					? `· ${tailscale.name}`
					: tailscale
					? "isn't connected"
					: "…"}
			</Check>
			<Check ok={!!github}>
				{github ? `GitHub · ${github}` : (
					<>
						GitHub: run <code>gh auth login</code>
					</>
				)}
			</Check>
		</div>
	);
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			{ok
				? <IconCheck className="size-3.5 text-primary" aria-hidden />
				: <span className="font-semibold text-warning">!</span>}
			{children}
		</span>
	);
}

function Steps({ current }: { current: Step }) {
	return (
		<ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
			{Object.entries(STEPS).map(([step, label], index) => (
				<li
					key={step}
					className={`flex items-center gap-2 ${
						step === current ? "font-medium text-foreground" : ""
					}`}
				>
					{index > 0 && <span className="h-px w-3 bg-border" aria-hidden />}
					{label}
				</li>
			))}
		</ol>
	);
}

function Header({ title, description }: { title: string; description: ReactNode }) {
	return (
		<DialogHeader>
			<DialogTitle>{title}</DialogTitle>
			<DialogDescription>{description}</DialogDescription>
		</DialogHeader>
	);
}

function Footer({ back, next }: { back?: ReactNode; next: ReactNode }) {
	return (
		<DialogFooter className="flex-row items-center justify-between sm:justify-between">
			<div className="flex items-center gap-1">{back}</div>
			{next}
		</DialogFooter>
	);
}

function Choice({ selected, onSelect, title, children }: {
	selected: boolean;
	onSelect: () => void;
	title: ReactNode;
	children: ReactNode;
}) {
	return (
		<div
			role="radio"
			aria-checked={selected}
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(event) => {
				if (event.key === " " || event.key === "Enter") {
					event.preventDefault();
					onSelect();
				}
			}}
			className={`cursor-pointer rounded-lg border bg-card px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${
				selected ? "border-primary ring-1 ring-primary" : ""
			}`}
		>
			<div className="flex items-center gap-2 text-sm font-medium">{title}</div>
			<div className="mt-0.5 text-xs leading-5 text-muted-foreground">{children}</div>
		</div>
	);
}

function Toggle({ checked, onChange, disabled, title, description }: {
	checked: boolean;
	onChange?: (checked: boolean) => void;
	disabled?: boolean;
	title: ReactNode;
	description: string;
}) {
	const id = useId();
	return (
		<div className="flex gap-3 rounded-lg border bg-card px-3.5 py-3">
			<Switch
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={onChange}
				className="mt-0.5"
			/>
			<label htmlFor={id} className={`flex flex-col gap-0.5 ${disabled ? "opacity-60" : ""}`}>
				<span className="flex items-center gap-2 text-sm font-medium">{title}</span>
				<span className="text-xs leading-5 text-muted-foreground">{description}</span>
			</label>
		</div>
	);
}

function Pill({ recommended, children }: { recommended?: boolean; children: ReactNode }) {
	return (
		<span
			className={`rounded-full px-2 text-[0.6875rem] font-medium leading-5 ${
				recommended ? "bg-primary/15 text-primary" : "border text-muted-foreground"
			}`}
		>
			{children}
		</span>
	);
}

function Invite({ children }: { children: ReactNode }) {
	return (
		<ol className="flex list-decimal flex-col gap-2 pl-5 text-sm marker:text-muted-foreground">
			{children}
		</ol>
	);
}

function Link({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="text-primary underline-offset-2 hover:underline"
		>
			{children}
		</a>
	);
}

function Copyable({ value, secret }: { value: string; secret?: boolean }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex min-w-0 items-center gap-2 rounded-md border bg-card py-1 pr-1 pl-3 font-mono text-xs">
			<span className="min-w-0 flex-1 truncate">{secret ? "•".repeat(24) : value}</span>
			<Button
				size="sm"
				variant="ghost"
				aria-label={secret ? "Copy team secret" : "Copy"}
				onClick={() =>
					void navigator.clipboard.writeText(value).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})}
			>
				{copied ? <IconCheck aria-hidden /> : <IconCopy aria-hidden />}
			</Button>
		</div>
	);
}
