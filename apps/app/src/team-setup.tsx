import { type ReactNode, useEffect, useId, useState } from "react";

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
	toast,
} from "@ace/ui";
import { IconArrowUpRight, IconCheck, IconCopy, IconLoader, IconUsers } from "@ace/ui/icons";
import { type Diagnostics, TEAM_ASK_EXPIRES, type TeamPeer } from "@ace/host/protocol";

import { host } from "./host";
import { useDiagnostics } from "./host-settings";
import { type Invite as Team, link, page, parse } from "./invite";
import { Row, Status, Value, when } from "./settings-layout";

const DOCS = "https://github.com/githubnext/ace/blob/main/docs/setup.md";
export const TEAM_SETUP = "ace:team-setup";
const PROVIDERS = {
	cloudflare: { label: "Cloudflare" },
	fly: { label: "Fly.io" },
};

// Names, URLs, and secrets are typed exactly; macOS would otherwise capitalize and correct them.
const RAW = { autoCorrect: "off", autoCapitalize: "off", spellCheck: false } as const;

type Provider = keyof typeof PROVIDERS;
type Step = "fork" | "join" | "directory" | "setup" | "invite" | "solo";
const STEPS: Partial<Record<Step, string>> = {
	directory: "Directory",
	setup: "Set up",
	invite: "Invite",
};

/**
 * First-run setup for the first person on a tailnet, or a way into the team for everyone after.
 * Membership stays the tailnet's: this only decides where the team's channels are listed.
 * `invite` opens on joining with an invite link's values; `inviting` opens on this team's invite.
 */
/** Sidebar footer entry to team setup, where Ask to join and deploying a directory live. */
export function TeamSetupItem() {
	return (
		<button
			type="button"
			onClick={() => window.dispatchEvent(new Event(TEAM_SETUP))}
			className="mx-2 mb-2 flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
		>
			<IconUsers className="size-3.5" aria-hidden />
			Team setup
		</button>
	);
}

export function TeamSetup({ github, invite, inviting, onClose }: {
	github?: string;
	invite?: Team;
	inviting?: boolean;
	onClose: () => void;
}) {
	const [step, setStep] = useState<Step>(invite ? "join" : inviting ? "invite" : "fork");
	const [starting, setStarting] = useState(true);
	const [listed, setListed] = useState<"hosted" | "peers">("hosted");
	const [provider, setProvider] = useState<Provider>("cloudflare");
	const [joined, setJoined] = useState<Team>();
	const [error, setError] = useState("");
	const checks = useDiagnostics(step === "fork");
	const checked = checks.value;
	const directory = checked?.directory.url ? checked.directory : undefined;
	// Until the host answers, the fork can't tell a first person from one already in a team.
	const pending = checks.open && !checked && !checks.error;

	useEffect(() => {
		if (!inviting) return;
		host.request<Team>({ op: "team-invite" }).then(
			setJoined,
			(error: Error) => setError(error.message),
		);
	}, [inviting]);

	return (
		<Dialog open onOpenChange={next => next || onClose()}>
			<DialogContent className="gap-4 sm:max-w-[34rem]">
				{STEPS[step] && !inviting && <Steps current={step} />}
				{step === "fork" && directory && (
					<>
						<Checks github={github} />
						<Header
							title="Your team"
							description={directory.serving
								? "This Mac serves your team's directory. Teammates on the tailnet join it on their own."
								: `This Mac is in your team's directory at ${new URL(directory.url!).host}.`}
						/>
						<div className="flex flex-col divide-y divide-border/60 rounded-md border border-border/70 px-3">
							<DirectoryHosts directory={directory} self={checked?.tailscale.name} />
						</div>
						<Nearby onJoined={onClose} team={new URL(directory.url!).host} />
						<Footer
							back={
								<Button variant="ghost" onClick={() => setStep("directory")}>
									List channels elsewhere…
								</Button>
							}
							next={<Button onClick={onClose}>Done</Button>}
						/>
					</>
				)}
				{step === "fork" && pending && <Checks github={github} />}
				{step === "fork" && !pending && !directory && (
					<>
						<Checks github={github} />
						<Header
							title="Set up Ace for your team"
							description="Everyone on your tailnet is your team. Start with how they'll find each other's channels."
						/>
						<Nearby onJoined={onClose} />
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
								Someone already set Ace up. Ask them to let you in, or use the directory URL they
								sent you.
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
							description={invite
								? "Check the directory before you join: it lists your channels for everyone who has this link."
								: "Ask a teammate on your tailnet to let you in, or enter their directory URL. A deployed directory also needs the team secret, which its invite link carries."}
						/>
						{!invite && <Nearby onJoined={onClose} />}
						<Join initial={invite} onJoined={onClose} back={() => setStep("fork")} />
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
								awake, with no shared projects or presence.
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
								<Button onClick={() => setStep(listed === "hosted" ? "setup" : "solo")}>
									Continue
								</Button>
							}
						/>
					</>
				)}
				{step === "setup" && (
					<Setup
						provider={provider}
						back={() => setStep("directory")}
						onJoined={(url, secret) => {
							setJoined({ url, secret });
							setStep("invite");
						}}
					/>
				)}
				{step === "invite" && (
					<>
						<Header
							title={inviting ? "Invite your team" : "Your team is ready"}
							description="Send teammates these steps."
						/>
						{joined
							? <Members team={joined} />
							: error
							? <p role="alert" className="text-xs text-destructive">{error}</p>
							: <p className="text-xs text-muted-foreground">Reading the invite…</p>}
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

function Setup({ provider, back, onJoined }: {
	provider: Provider;
	back: () => void;
	onJoined: (url: string, secret: string) => void;
}) {
	const command = `bun services/deploy.ts ${provider}`;
	// Ace deploys Cloudflare's bundled services itself; Fly.io still needs a checkout and flyctl.
	if (provider === "cloudflare") {
		return <Deploy command={command} back={back} onJoined={onJoined} />;
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
			<Join deployed onJoined={onJoined} back={back} />
		</>
	);
}

function Deploy({ command, back, onJoined }: {
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
		{ label: "Deploy the directory", from: "Deploying the directory" },
		{ label: "Join this Mac", from: "Joining" },
	];
	const [stage, setStage] = useState(-1);

	async function deploy() {
		setBusy(true);
		setError("");
		setStage(0);
		try {
			const { url, secret } = await host.deployTeam((text) => {
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
				description={
					<>
						Ace deploys your tailnet's services to your Cloudflare account, makes a new team secret,
						and joins this Mac. You'll sign in to Cloudflare in your browser if you haven't before.
						{" "}
						<Link href={`${DOCS}#from-the-app`}>
							What this creates <IconArrowUpRight className="inline size-3" aria-hidden />
						</Link>
					</>
				}
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

/** The invite link, with its two values for anyone who joins by hand. */
function Members({ team }: { team: Team }) {
	const [separate, setSeparate] = useState(false);
	return (
		<>
			<Invite>
				<li>
					Download Ace from <Link href="https://ace.githubnext.com">ace.githubnext.com</Link>
				</li>
				<li>
					Get on your tailnet:{" "}
					<Link href="https://login.tailscale.com/admin/users">invite them in Tailscale</Link>
				</li>
				<li>
					Open the invite link, or paste it into Join your team
					<div className="mt-2 flex flex-col gap-1.5">
						<Copyable
							value={link(team)}
							label={`${page.replace("https://", "")} · ${new URL(team.url).host}`}
						/>
						{separate && (
							<>
								<Copyable value={team.url} />
								<Copyable value={team.secret} secret />
							</>
						)}
					</div>
					<Button
						variant="link"
						size="sm"
						className="h-auto px-0 text-xs"
						onClick={() => setSeparate(!separate)}
					>
						{separate ? "Hide the URL and secret" : "Copy the URL and secret separately"}
					</Button>
				</li>
			</Invite>
			<p className="rounded-md bg-muted px-3 py-2 text-xs leading-5">
				<b className="font-medium">Send it privately.</b>{" "}
				The link holds the team secret: anyone with it can read every channel's name and summary.
			</p>
		</>
	);
}

/** Peers' hosts already in a team; asked again while open, since a teammate may come online. */
function useTeamPeers(): TeamPeer[] {
	const [peers, setPeers] = useState<TeamPeer[]>([]);
	useEffect(() => {
		let live = true;
		const load = () =>
			host.request<TeamPeer[]>({ op: "team-peers" }).then(
				(value) => live && setPeers(value),
				() => {},
			);
		void load();
		const timer = setInterval(load, 5000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, []);
	return peers;
}

const CLOCK = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Ask a teammate's host to let this one in; their owner approves in their Ace. */
function Nearby({ onJoined, team }: { onJoined: () => void; team?: string }) {
	// A teammate already in this host's directory has no other team to let it into.
	const peers = useTeamPeers().filter((peer) => peer.team !== team);
	// By host: the peer list is read again every few seconds, which replaces its objects.
	const [asking, setAsking] = useState<{ host: string; who: string; lapses: number }>();
	const [error, setError] = useState("");
	if (!peers.length) return null;

	async function ask(peer: TeamPeer) {
		const who = peer.github || peer.login;
		setAsking({ host: peer.host, who, lapses: Date.now() + TEAM_ASK_EXPIRES });
		setError("");
		try {
			await host.request({ op: "team-ask", host: peer.host });
			// Joining closes Team setup, and the asker is often at their teammate's screen while they
			// approve, so the news waits outside it until dismissed.
			toast.success(`${who} let you in`, {
				description: "You're in your team's directory now.",
				duration: Infinity,
			});
			onJoined();
		} catch (error) {
			setError((error as Error).message);
		} finally {
			setAsking(undefined);
		}
	}

	return (
		<div className="flex flex-col gap-2">
			{peers.map((peer) => (
				<div
					key={peer.host}
					className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm"
				>
					<span className="min-w-0">
						<span className="font-medium">{peer.github || peer.login}</span>
						<span className="text-muted-foreground">
							{" "}on {peer.host} is in a team.
						</span>
					</span>
					<Button
						size="sm"
						variant="outline"
						disabled={!!asking}
						onClick={() => void ask(peer)}
					>
						{asking?.host === peer.host && (
							<IconLoader className="size-3.5 animate-spin" aria-hidden />
						)}
						{asking?.host === peer.host ? "Waiting…" : "Ask to join"}
					</Button>
				</div>
			))}
			{asking && (
				<p className="text-xs text-muted-foreground">
					Asked {asking.who}{" "}
					to approve it in their Ace. You join as soon as they do; the request lapses at{" "}
					{CLOCK.format(asking.lapses)} if nobody answers.
				</p>
			)}
			{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
		</div>
	);
}

/**
 * Today's Settings → Team join: the directory checks the secret before either is saved. As there, a
 * blank secret is left out, for a directory a host serves on the tailnet or a secret already saved.
 * A new deployment's invite carries its secret, so `deployed` requires one.
 */
function Join({ initial, deployed, onJoined, back }: {
	initial?: Team;
	deployed?: boolean;
	onJoined: (url: string, secret: string) => void;
	back: () => void;
}) {
	const id = useId();
	const [url, setUrl] = useState(initial?.url || "");
	const [secret, setSecret] = useState(initial?.secret || "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function join() {
		setBusy(true);
		setError("");
		try {
			await host.request({ op: "directory-set", url, ...(secret.trim() ? { secret } : {}) });
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
					aria-label="Directory URL or invite link"
					placeholder="Directory URL or invite link"
					value={url}
					disabled={busy}
					onChange={(event) => {
						const invite = parse(event.target.value);
						setUrl(invite?.url || event.target.value);
						if (invite) setSecret(invite.secret);
					}}
				/>
				<Input
					{...RAW}
					type="password"
					autoComplete="new-password"
					aria-label="Team secret"
					placeholder={deployed ? "Team secret" : "Team secret, for a deployed directory"}
					value={secret}
					disabled={busy}
					onChange={(event) => setSecret(event.target.value)}
				/>
				{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
			</form>
			<Footer
				back={<Button variant="ghost" disabled={busy} onClick={back}>Back</Button>}
				next={
					<Button
						type="submit"
						form={id}
						disabled={busy || !url.trim() || (deployed && !secret.trim())}
					>
						{busy ? "Checking…" : "Check and join"}
					</Button>
				}
			/>
		</>
	);
}

export function Checks({ github }: { github?: string }) {
	const { value } = useDiagnostics(true);
	const tailscale = value?.tailscale;
	const cli = value?.tools.find((tool) => tool.name === "GitHub CLI");
	// hello's login can arrive before gh answers and isn't resent, so a fresh host's check reads gh here.
	const login = cli?.account || github;
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
			<Check ok={tailscale?.state === "running"}>
				Tailscale {tailscale?.state === "running"
					? `· ${tailscale.name}`
					: tailscale
					? "isn't connected"
					: "…"}
			</Check>
			<Check ok={!!login}>
				{login ? `GitHub · ${login}` : cli && !cli.path
					? (
						<>
							GitHub: install GitHub CLI, then run <code>gh auth login</code>
						</>
					)
					: (
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

export function Header({ title, description }: { title: string; description: ReactNode }) {
	return (
		<DialogHeader>
			<DialogTitle>{title}</DialogTitle>
			<DialogDescription>{description}</DialogDescription>
		</DialogHeader>
	);
}

export function Footer({ back, next }: { back?: ReactNode; next: ReactNode }) {
	return (
		<DialogFooter className="flex-row items-center justify-between sm:justify-between">
			<div className="flex items-center gap-1">{back}</div>
			{next}
		</DialogFooter>
	);
}

export function Choice({ selected, onSelect, title, children }: {
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

export function Pill({ recommended, children }: { recommended?: boolean; children: ReactNode }) {
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

export function Link({ href, children }: { href: string; children: ReactNode }) {
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

/** `label` shows in place of a value that carries a secret. */
export function Copyable(
	{ value, secret, label }: { value: string; secret?: boolean; label?: string },
) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex min-w-0 items-center gap-2 rounded-md border bg-card py-1 pr-1 pl-3 font-mono text-xs">
			<span className="min-w-0 flex-1 truncate">{secret ? "•".repeat(24) : label || value}</span>
			<Button
				size="sm"
				variant="ghost"
				aria-label={secret ? "Copy team secret" : label ? "Copy invite link" : "Copy"}
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

/** Hosts that have joined the directory, and when each last published its channels there. */
export function DirectoryHosts(
	{ directory, self }: { directory: Diagnostics["directory"]; self?: string },
) {
	if (!directory.hosts?.length) {
		return (
			<div className="py-3">
				<Status>
					{directory.synced ? "No hosts have joined yet." : "Waiting for the directory…"}
				</Status>
			</div>
		);
	}
	return (
		<>
			{directory.hosts?.map((host) => (
				<Row
					key={host.name}
					label={host.name === self ? `${host.name} (this Mac)` : host.name}
					description={host.github || host.login}
				>
					<Value>Synced {when(host.seen)}</Value>
				</Row>
			))}
		</>
	);
}
