import { useState } from "react";

import { Button, Dialog, DialogContent, Input } from "@ace/ui";
import { IconCheck, IconDatabase, IconKey, IconLaptop, IconLoader, IconX } from "@ace/ui/icons";

import { Group, Page, Row, Value } from "./settings-layout";
import { Checks, Choice, Copyable, Footer, Header, Link, Pill } from "./team-setup";

/*
 * Design lane only: the local-first onboarding screens, drawn with the app's own components so
 * the screenshots match what would ship. Nothing here talks to the host.
 */

const TEAM = [
	{ name: "nate", host: "natembp", status: "This Mac", online: true },
	{ name: "sam", host: "sam-studio", status: "2 channels", online: true },
	{ name: "mira", host: "mira-mbp", status: "Asleep · last seen 3h ago", online: false },
];

function Person({ name, online }: { name: string; online: boolean }) {
	return (
		<span className="relative grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium uppercase">
			{name[0]}
			<span
				className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background ${
					online ? "bg-primary" : "bg-muted-foreground/50"
				}`}
			/>
		</span>
	);
}

function People() {
	return (
		<ul className="flex flex-col divide-y divide-border/60 rounded-lg border bg-card">
			{TEAM.map(({ name, host, status, online }) => (
				<li key={name} className="flex items-center gap-3 px-3.5 py-2.5">
					<Person name={name} online={online} />
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="text-sm font-medium">{name}</span>
						<span className="text-xs text-muted-foreground">{host}</span>
					</div>
					<span className="text-xs text-muted-foreground">{status}</span>
				</li>
			))}
		</ul>
	);
}

function Stages({ stages, at, busy }: { stages: string[]; at: number; busy?: boolean }) {
	return (
		<ol className="flex flex-col gap-1.5 text-sm">
			{stages.map((label, index) => (
				<li key={label} className="flex items-center gap-2">
					{index < at
						? <IconCheck className="size-3.5 text-primary" aria-hidden />
						: index === at && busy
						? <IconLoader className="size-3.5 animate-spin" aria-hidden />
						: <span className="size-3.5 text-center text-muted-foreground">·</span>}
					<span className={index > at || (index === at && !busy) ? "text-muted-foreground" : ""}>
						{label}
					</span>
				</li>
			))}
		</ol>
	);
}

/** First run: the checks and a model key, then the team the tailnet already is. */
export function Welcome({ github, initial, onClose }: {
	github?: string;
	initial: "key" | "team";
	onClose: () => void;
}) {
	const [step, setStep] = useState(initial);
	const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
	return (
		<Dialog open onOpenChange={next => next || onClose()}>
			<DialogContent className="gap-4 sm:max-w-[34rem]">
				{step === "key" && (
					<>
						<Checks github={github} />
						<Header
							title="Welcome to Ace"
							description="Agents in your channels run on this Mac with your own model key."
						/>
						<div className="flex flex-col gap-2 rounded-lg border bg-card px-3.5 py-3">
							<div className="flex gap-1.5">
								{(["anthropic", "openai"] as const).map(id => (
									<Button
										key={id}
										size="sm"
										variant="outline"
										aria-pressed={provider === id}
										className={`border ${provider === id ? "border-primary text-primary" : ""}`}
										onClick={() => setProvider(id)}
									>
										{id === "anthropic" ? "Anthropic" : "OpenAI"}
									</Button>
								))}
							</div>
							<Input
								type="password"
								aria-label="API key"
								className="font-mono text-xs"
								defaultValue="sk-ant-api03-design-only-placeholder-key"
							/>
							<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
								<IconCheck className="size-3.5 text-primary" aria-hidden />
								Key works. Saved in Keychain.
							</span>
						</div>
						<Footer
							back={
								<Button variant="ghost" onClick={() => setStep("team")}>Chat only for now</Button>
							}
							next={<Button onClick={() => setStep("team")}>Continue</Button>}
						/>
					</>
				)}
				{step === "team" && (
					<>
						<Header
							title="Your team is your tailnet"
							description="Everyone on your tailnet who runs Ace is on your team. There's nothing to join."
						/>
						<People />
						<p className="text-xs leading-5 text-muted-foreground">
							Add people in the{" "}
							<Link href="https://login.tailscale.com/admin/users">Tailscale admin console</Link>,
							and they show up here when they open Ace.
						</p>
						<Footer
							back={<Button variant="ghost" onClick={() => setStep("key")}>Back</Button>}
							next={<Button onClick={onClose}>Open a project</Button>}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Sidebar footer upsell while the team has no directory. */
export function DirectoryCard(
	{ onCreate, onDismiss }: { onCreate: () => void; onDismiss: () => void },
) {
	return (
		<div className="m-2 flex shrink-0 flex-col gap-2 rounded-lg border bg-card p-3">
			<div className="flex items-center gap-2">
				<IconDatabase className="size-3.5 shrink-0 text-primary" aria-hidden />
				<span className="flex-1 text-xs font-medium">Team directory</span>
				<button
					type="button"
					aria-label="Dismiss"
					className="text-muted-foreground hover:text-foreground"
					onClick={onDismiss}
				>
					<IconX className="size-3.5" aria-hidden />
				</button>
			</div>
			<p className="text-xs leading-5 text-muted-foreground">
				Keep channels listed while Macs sleep, and share projects.
			</p>
			<Button size="sm" variant="outline" className="border" onClick={onCreate}>
				Create directory
			</Button>
		</div>
	);
}

/** An offline channel on a teammate's Mac, while the team has no directory. */
export function Asleep(
	{ name, host, onCreate }: { name: string; host: string; onCreate: () => void },
) {
	return (
		<div
			className="grid h-full place-content-center justify-items-center gap-5 px-6 text-center"
			role="status"
		>
			<div className="flex flex-col items-center gap-2">
				<IconLaptop className="size-6 text-muted-foreground" aria-hidden />
				<p className="text-base font-medium">{host} is asleep</p>
				<p className="max-w-sm text-sm text-muted-foreground">
					{name} runs on that Mac. Its chat opens here when the Mac wakes.
				</p>
			</div>
			<div className="flex max-w-sm flex-col gap-3 rounded-lg border bg-card p-4 text-left">
				<div className="flex items-start gap-2.5">
					<IconDatabase className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
					<p className="text-xs leading-5 text-muted-foreground">
						<span className="font-medium text-foreground">Your team has no directory.</span>{" "}
						Ace only knows channels it saw while their Mac was awake. A directory keeps every
						channel listed, with its latest activity, while Macs sleep.
					</p>
				</div>
				<Button size="sm" onClick={onCreate}>Create directory</Button>
			</div>
		</div>
	);
}

type Step = "where" | "fly" | "deploying" | "done";
const STAGES = [
	"Sign in to Fly.io",
	"Add ace-directory to your tailnet",
	"Start the directory",
	"Point your team at it",
];

/** Where the directory runs, then its deploy; teammates' hosts find it through their peers. */
export function CreateDirectory({ initial, onAdd, onClose }: {
	initial: Step;
	onAdd: () => void;
	onClose: () => void;
}) {
	const [step, setStep] = useState(initial);
	const [where, setWhere] = useState<"fly" | "machine" | "here">("fly");
	return (
		<Dialog open onOpenChange={next => next || onClose()}>
			<DialogContent className="gap-4 sm:max-w-[34rem]">
				{step === "where" && (
					<>
						<Header
							title="Create your team's directory"
							description="It lists every channel, shares projects, and shows who's around. It runs on your tailnet, so only your team can reach it."
						/>
						<div role="radiogroup" className="flex flex-col gap-2">
							<Choice
								selected={where === "fly"}
								onSelect={() => setWhere("fly")}
								title={
									<>
										Fly.io <Pill recommended>Recommended</Pill>
									</>
								}
							>
								Always on. A small machine in your Fly account, joined to your tailnet.
							</Choice>
							<Choice
								selected={where === "machine"}
								onSelect={() => setWhere("machine")}
								title="A machine on your tailnet"
							>
								A Mac mini or server that stays on and runs Ace.
							</Choice>
							<Choice
								selected={where === "here"}
								onSelect={() => setWhere("here")}
								title="This Mac"
							>
								Nothing to deploy. Pauses while this Mac sleeps; move it later.
							</Choice>
						</div>
						<Footer
							back={<Button variant="ghost" onClick={onClose}>Cancel</Button>}
							next={<Button onClick={() => setStep("fly")}>Continue</Button>}
						/>
					</>
				)}
				{(step === "fly" || step === "deploying") && (
					<>
						<Header
							title="Deploy to Fly.io"
							description="Ace creates ace-directory in your Fly account and adds it to your tailnet. You'll approve both in your browser."
						/>
						<Stages stages={STAGES} at={step === "fly" ? 0 : 2} busy={step === "deploying"} />
						<Footer
							back={
								<Button
									variant="ghost"
									disabled={step === "deploying"}
									onClick={() => setStep("where")}
								>
									Back
								</Button>
							}
							next={
								<Button disabled={step === "deploying"} onClick={() => setStep("deploying")}>
									{step === "deploying" ? "Deploying…" : "Deploy"}
								</Button>
							}
						/>
					</>
				)}
				{step === "done" && (
					<>
						<Header
							title="Your team's directory is running"
							description="Teammates' Macs find it on the tailnet. There's nothing to send."
						/>
						<Copyable value="ace-directory.tail4c2e.ts.net" />
						<ul className="flex flex-col divide-y divide-border/60 rounded-lg border bg-card">
							{TEAM.map(({ name, host, online }) => (
								<li key={name} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
									<Person name={name} online={online} />
									<span className="flex-1">{host}</span>
									<span className="text-xs text-muted-foreground">
										{online ? "Listed" : "Joins when it wakes"}
									</span>
								</li>
							))}
						</ul>
						<Footer
							back={<Button variant="ghost" onClick={onAdd}>Add a teammate</Button>}
							next={<Button onClick={onClose}>Done</Button>}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Getting someone onto the team is getting them onto the tailnet. */
export function AddTeammate({ onClose }: { onClose: () => void }) {
	return (
		<Dialog open onOpenChange={next => next || onClose()}>
			<DialogContent className="gap-4 sm:max-w-[30rem]">
				<Header
					title="Add a teammate"
					description="Anyone on your tailnet who runs Ace is on your team."
				/>
				<ol className="flex list-decimal flex-col gap-3 pl-5 text-sm marker:text-muted-foreground">
					<li>
						Add them in the{" "}
						<Link href="https://login.tailscale.com/admin/users">Tailscale admin console</Link>
					</li>
					<li>
						Send them the download
						<div className="mt-2">
							<Copyable value="https://ace.githubnext.com" />
						</div>
					</li>
				</ol>
				<p className="text-xs leading-5 text-muted-foreground">
					They add their own model key, and Ace finds the team when they open it.
				</p>
				<Footer next={<Button onClick={onClose}>Done</Button>} />
			</DialogContent>
		</Dialog>
	);
}

/** Settings → Team once the directory runs: no secret, people named by the tailnet. */
export function TeamAfter({ onAdd, onSandboxes }: { onAdd: () => void; onSandboxes: () => void }) {
	return (
		<Page>
			<Group title="Directory">
				<Row label="ace-directory" description="Fly.io · on your tailnet · created by nate">
					<Value>Running</Value>
					<Button size="sm" variant="outline">Move…</Button>
				</Row>
			</Group>
			<Group
				title="People"
				action={<Button size="sm" variant="outline" onClick={onAdd}>Add a teammate</Button>}
			>
				{TEAM.map(({ name, host, status, online }) => (
					<Row
						key={name}
						label={
							<span className="flex items-center gap-2.5">
								<Person name={name} online={online} />
								{name}
							</span>
						}
					>
						<Value>{host} · {status}</Value>
					</Row>
				))}
			</Group>
			<Group title="Sandboxes">
				<Row label="Run channels in the cloud" description="For work that shouldn't tie up a Mac.">
					<Button size="sm" variant="outline" onClick={onSandboxes}>Set up</Button>
				</Row>
			</Group>
		</Page>
	);
}

/** Sandboxes are the one service off the tailnet, and the one place a model key is shared. */
export function Sandboxes({ onClose }: { onClose: () => void }) {
	return (
		<Dialog open onOpenChange={next => next || onClose()}>
			<DialogContent className="gap-4 sm:max-w-[34rem]">
				<Header
					title="Set up sandboxes"
					description="Ace deploys sandboxes to your Cloudflare account. They check each request against your tailnet's identity."
				/>
				<div className="flex flex-col gap-2 rounded-lg border bg-card px-3.5 py-3">
					<span className="flex items-center gap-2 text-sm font-medium">
						<IconKey className="size-3.5" aria-hidden />
						Team model key <Pill>Shared</Pill>
					</span>
					<Input
						type="password"
						aria-label="Team model key"
						className="font-mono text-xs"
						placeholder="Anthropic or OpenAI API key"
					/>
					<span className="text-xs leading-5 text-muted-foreground">
						Every sandbox run bills this key. It's stored in Cloudflare, not in anyone's Keychain.
					</span>
				</div>
				<Stages
					stages={["Sign in to Cloudflare", "Deploy sandboxes", "Trust your tailnet's identity"]}
					at={0}
				/>
				<Footer
					back={<Button variant="ghost" onClick={onClose}>Cancel</Button>}
					next={<Button>Deploy</Button>}
				/>
			</DialogContent>
		</Dialog>
	);
}
