import { type ReactNode, useState, useSyncExternalStore } from "react";

import type { Listing, People } from "@ace/host/protocol";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	toast,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ace/ui";
import { IconBot, IconCloud, IconLaptop, IconMonitor } from "@ace/ui/icons";

import { useDetails } from "./details";
import { host } from "./host";
import { placement } from "./placement";

/**
 * What teammates' runs can reach. A cloud container has no desktop tools and no macOS
 * permissions, so its copy names neither. A guest reads whose account and machine they would use.
 */
function reach(
	channel: Listing,
	owner: boolean,
	people: People,
): { agents: string; confirm: string; desktop: boolean } {
	const place = placement(channel);
	if (place.kind === "cloud") {
		return {
			agents:
				`Let teammates invoke this channel's agents, which run commands in this channel's cloud container on ${place.service}, with its GitHub access to the repository. No macOS permissions apply. Turning this off leaves chat available and active runs continue.`,
			confirm:
				"Teammates can run commands in this channel's cloud container, with its GitHub access to the repository. No macOS permissions apply.",
			desktop: false,
		};
	}
	const name = people[channel.owner] || channel.owner.split("@")[0];
	const machine = place.kind === "local" ? place.host : place.workspace;
	return {
		agents: owner
			? "Let teammates invoke this channel's agents, which run commands as you on this machine with Ace's macOS permissions, such as Screen Recording. Turning this off leaves chat available and active runs continue."
			: `Teammates can invoke this channel's agents, which run commands as ${name} on ${machine}, with ${name}'s model keys and Ace's macOS permissions there, such as Screen Recording.`,
		confirm:
			"Teammates can run commands as you on this machine, with Ace's macOS permissions such as Screen Recording.",
		desktop: true,
	};
}

/** Where the channel runs: a cloud for a hosted or compute channel, otherwise its host. */
function Machine({ channel }: { channel: Listing }) {
	const place = placement(channel);
	const [Icon, name, detail] = place.kind === "cloud"
		? [IconCloud, "Cloud", `Tools run in a container on ${place.service}.`]
		: place.kind === "hosted"
		? [
			IconCloud,
			place.workspace,
			`Hosted on ${place.service}. Tools run on ${place.workspace}.`,
		]
		: [IconLaptop, place.host, `Runs on ${place.host}.`];
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className="mr-3 inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground" />
				}
			>
				<Icon className="size-3.5 shrink-0" aria-hidden />
				{/* A phone's tab strip needs the room; the icon's tooltip still names the machine. */}
				<span className="max-w-40 truncate max-sm:sr-only">{name}</span>
			</TooltipTrigger>
			<TooltipContent>{detail}</TooltipContent>
		</Tooltip>
	);
}

function AccessToggle({ label, value, live, owner, pending, description, children, onClick }: {
	label: string;
	value?: boolean;
	live?: boolean;
	owner: boolean;
	pending: boolean;
	description: string;
	children: ReactNode;
	onClick: () => void;
}) {
	const state = value === undefined ? "Unknown" : value ? "On" : "Off";
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className="inline-flex shrink-0">
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={label}
							aria-pressed={value === undefined ? "mixed" : value}
							disabled={!owner || !live || pending}
							className="text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary"
							onClick={onClick}
						>
							{children}
						</Button>
					</span>
				}
			/>
			<TooltipContent className="max-w-72 flex-col items-start">
				<p className="font-medium">{label}: {state}</p>
				<p>{description}</p>
				{!owner && <p>Only the channel owner can change this.</p>}
				{owner && !live && <p>Waiting for live settings. Older hosts need an Ace update.</p>}
			</TooltipContent>
		</Tooltip>
	);
}

export function ChannelAccess({ channel, user }: { channel: Listing; user: string }) {
	const { shared, sharedLive, desktop, desktopLive } = useDetails(channel.id);
	const [sharing, setSharing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [changingDesktop, setChangingDesktop] = useState(false);
	const people = useSyncExternalStore(host.subscribe, () => host.people);
	const owner = channel.owner === user;
	const copy = reach(channel, owner, people);

	// Render only watch-confirmed values, never an optimistic permission grant.
	function share() {
		setConfirming(false);
		setSharing(true);
		host.channel(channel.id, { op: "share", author: user, shared: !shared }).catch(
			(error: Error) =>
				toast.error("Could not change agent access", { description: error.message }),
		).finally(() => setSharing(false));
	}

	function computer() {
		setChangingDesktop(true);
		host.channel(channel.id, { op: "desktop", author: user, enabled: !desktop }).catch(
			(error: Error) =>
				toast.error("Could not change desktop tools access", { description: error.message }),
		).finally(() => setChangingDesktop(false));
	}

	return (
		<div
			role="group"
			aria-label="Channel access"
			className="mr-2 flex shrink-0 items-center gap-0.5 electrobun-webkit-app-region-no-drag"
		>
			<Machine channel={channel} />
			<AccessToggle
				label="Agent access"
				value={shared}
				live={sharedLive}
				owner={owner}
				pending={sharing}
				description={copy.agents}
				onClick={() => shared ? share() : setConfirming(true)}
			>
				<IconBot aria-hidden />
			</AccessToggle>
			{copy.desktop && (
				<AccessToggle
					label="Channel desktop tools"
					value={desktop}
					live={desktopLive}
					owner={owner}
					pending={changingDesktop}
					description="Allow native computer use in this channel, including the owner's and teammates' runs. Turning this off refuses new desktop calls only. Shell commands keep Ace's macOS permissions, such as Screen Recording, so this isn't a security boundary."
					onClick={computer}
				>
					<IconMonitor aria-hidden />
				</AccessToggle>
			)}
			<Dialog open={confirming} onOpenChange={setConfirming}>
				<DialogContent className="gap-3 sm:max-w-80" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle>Let teammates invoke agents?</DialogTitle>
						<DialogDescription>
							{copy.confirm}
							{copy.desktop && desktop
								&& " Desktop tools are on, so they can also operate your apps."}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setConfirming(false)}>
							Cancel
						</Button>
						<Button type="button" onClick={share}>Turn on</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
