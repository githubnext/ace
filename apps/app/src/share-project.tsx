import { useEffect, useState } from "react";

import { type Listing, type Person, type ProjectAccess, TEAM } from "@ace/host/protocol";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Switch,
	toast,
} from "@ace/ui";

import { host } from "./host";

/** Whether this host's owner can share `project`, which only direct access allows. */
export function useCanShare(project: string | undefined, connected: boolean): boolean {
	const [direct, setDirect] = useState<{ project: string; direct: boolean }>();
	useEffect(() => {
		if (!project || !connected) return;
		let current = true;
		host.request<ProjectAccess>({ op: "project-access", project }).then(
			(access) => current && setDirect({ project, direct: access.direct }),
			() => current && setDirect({ project, direct: false }),
		);
		return () => {
			current = false;
		};
	}, [project, connected]);
	return direct?.project === project && direct?.direct === true;
}

const VIA: Record<NonNullable<Person["via"]>, string> = {
	github: "Reads it on GitHub",
	folder: "Their folder",
	team: "Shared with the team",
	share: "Shared with them",
};

function list(names: string[]): string {
	if (names.length < 2) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

type Props = {
	project: string;
	name: string;
	/** This host owner's Tailscale login. */
	user: string;
	/** The project's channels, whose owners a share exposes. */
	channels: Listing[];
	onClose: () => void;
};

/**
 * A share opens the whole project: every person's channels in it, now and later (docs/terms.md),
 * so granting one always says whose channels it exposes first.
 */
export function ShareProject({ project, name, user, channels, onClose }: Props) {
	const [access, setAccess] = useState<ProjectAccess>();
	const [pending, setPending] = useState<{ person: string; name: string }>();
	const [busy, setBusy] = useState(false);

	async function load() {
		try {
			setAccess(await host.request<ProjectAccess>({ op: "project-access", project }));
		} catch (error) {
			toast.error("Could not read who can see this project", {
				description: (error as Error).message,
			});
			onClose();
		}
	}

	useEffect(() => {
		void load();
	}, [project]);

	async function change(person: string, shared: boolean) {
		setBusy(true);
		try {
			await host.request({ op: "project-share", project, person, shared });
			setPending(undefined);
			await load();
		} catch (error) {
			toast.error(shared ? "Could not share the project" : "Could not unshare the project", {
				description: (error as Error).message,
			});
		} finally {
			setBusy(false);
		}
	}

	const shared = new Set(access?.shares.map((share) => share.person));
	const github = (login: string) =>
		access?.people.find((value) => value.person === login)?.github || login;
	const others = access?.people.filter((value) => value.person !== user) || [];

	function exposed(person: string): string {
		const owners = new Set(channels.map((channel) => channel.owner));
		owners.delete(person);
		const names = [...owners].filter((owner) => owner !== user).map((owner) =>
			`${github(owner)}'s`
		);
		if (owners.has(user)) names.unshift("yours");
		return names.length ? `, including ${list(names)},` : "";
	}

	if (pending) {
		const team = pending.person === TEAM;
		return (
			<Dialog open onOpenChange={(next) => next || busy ? undefined : setPending(undefined)}>
				<DialogContent className="gap-3 sm:max-w-96" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle className="break-all">
							Share {name} with {team ? "the whole team" : pending.name}?
						</DialogTitle>
						<DialogDescription>
							{team ? "Everyone on the team" : pending.name} will see every channel in it
							{exposed(pending.person)}{" "}
							and any created later, and can post in them. Whether they can invoke a channel's agent
							stays that channel's agent access setting.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={() => setPending(undefined)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							disabled={busy}
							onClick={() => void change(pending.person, true)}
						>
							{busy ? "Sharing…" : "Share"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open onOpenChange={(next) => next || busy ? undefined : onClose()}>
			<DialogContent className="gap-4 sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="break-all">Share {name}</DialogTitle>
					<DialogDescription>
						People with access see every channel in this project, everyone's, and can post in them.
						People who can read it on GitHub always have access.
					</DialogDescription>
				</DialogHeader>
				{!access
					? <p className="text-sm text-muted-foreground">Checking who can see it…</p>
					: (
						<div className="flex flex-col gap-3 text-sm">
							{!access.direct && (
								<p className="text-muted-foreground">
									Only people who can read it on GitHub, or whose folder it is, can share it.
								</p>
							)}
							<label className="flex items-center justify-between gap-3">
								<span>Everyone on the team</span>
								<Switch
									checked={shared.has(TEAM)}
									disabled={!access.direct || busy}
									onCheckedChange={(next) =>
										next
											? setPending({ person: TEAM, name: "the team" })
											: void change(TEAM, false)}
								/>
							</label>
							<ul className="flex flex-col gap-2">
								{others.map((value) => {
									const login = value.github || value.person;
									return (
										<li key={value.person} className="flex items-center gap-2">
											<img
												src={`https://github.com/${value.github || "ghost"}.png?size=40`}
												alt=""
												className="size-5 rounded-full"
											/>
											<span className="min-w-0 flex-1 truncate">{login}</span>
											<span className="text-xs text-muted-foreground">
												{value.via ? VIA[value.via] : "No access"}
											</span>
											{access.direct && (value.via === "share" || !value.via) && (
												<Button
													type="button"
													size="sm"
													variant="outline"
													disabled={busy}
													onClick={() =>
														value.via
															? void change(value.person, false)
															: setPending({ person: value.person, name: login })}
												>
													{value.via ? "Unshare" : "Share"}
												</Button>
											)}
										</li>
									);
								})}
							</ul>
							{!others.length && (
								<p className="text-muted-foreground">
									No teammates found yet. They appear once their Ace is running on the tailnet.
								</p>
							)}
						</div>
					)}
			</DialogContent>
		</Dialog>
	);
}
