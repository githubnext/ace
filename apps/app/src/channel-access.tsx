import { type ReactNode, useState } from "react";

import type { Listing } from "@ace/host/protocol";
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
import { IconBot, IconMonitor } from "@ace/ui/icons";

import { useDetails } from "./details";
import { host } from "./host";
import { placement } from "./placement";

/**
 * What collaborators' runs can reach. A cloud container has no desktop tools and no macOS
 * permissions, so its copy names neither.
 */
function reach(channel: Listing): { agents: string; confirm: string; desktop: boolean } {
	const place = placement(channel);
	if (place.kind === "cloud") {
		return {
			agents:
				`Allow collaborators to invoke agents, which run commands in this channel's cloud container on ${place.service}, with its GitHub access to the repository. No macOS permissions apply. Turning this off leaves chat available and active runs continue.`,
			confirm:
				"Teammates can run commands in this channel's cloud container, with its GitHub access to the repository. No macOS permissions apply.",
			desktop: false,
		};
	}
	return {
		agents:
			"Allow collaborators to invoke agents, which run commands as you on this machine with Ace's macOS permissions, such as Screen Recording. Turning this off leaves chat available and active runs continue.",
		confirm:
			"Teammates can run commands as you on this machine, with Ace's macOS permissions such as Screen Recording.",
		desktop: true,
	};
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
			<TooltipContent className="max-w-72">
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
	const owner = channel.owner === user;
	const copy = reach(channel);

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
			<AccessToggle
				label="Collaborator agent access"
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
					description="Allow native computer use in this channel, including owner and collaborator runs. Turning this off refuses new desktop calls only. Shell commands keep Ace's macOS permissions, such as Screen Recording, so this isn't a security boundary."
					onClick={computer}
				>
					<IconMonitor aria-hidden />
				</AccessToggle>
			)}
			<Dialog open={confirming} onOpenChange={setConfirming}>
				<DialogContent className="gap-3 sm:max-w-80" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle>Let collaborators invoke agents?</DialogTitle>
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
