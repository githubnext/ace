import { useRef, useState } from "react";

import {
	Button,
	ChatComposer,
	type ChatComposerHandle,
	ProjectPicker,
	serialize,
	type SessionSidebarRepo,
} from "@ace/ui";
import { IconChevronDown, IconCloud, IconHash, IconPlus } from "@ace/ui/icons";
import type { Listing } from "@ace/host/protocol";

import { here } from "./desktop";
import { InitGit } from "./open-project";
import type { AppProject } from "./projects";

/**
 * A project's dashboard draft and history follow its identity, so setting up a GitHub project here
 * keeps them. Earlier versions scoped each to one checkout; the first one found moves over once.
 */
function adopt(project: AppProject): string {
	const scope = `/projects/${project.id}/dashboard`;
	for (const kind of ["draft", "history"]) {
		const key = `ace:${kind}:${scope}`;
		try {
			// useDraft still moves drafts that earlier versions kept in sessionStorage.
			const stores = kind === "draft" ? [localStorage, sessionStorage] : [localStorage];
			if (stores.some((store) => store.getItem(key) !== null)) continue;
			for (const checkout of project.checkouts) {
				const legacy = `ace:${kind}:/projects/${checkout}/dashboard`;
				const store = legacy !== key && stores.find((store) => store.getItem(legacy) !== null);
				if (!store) continue;
				// A failed write throws before the legacy copy is removed.
				store.setItem(key, store.getItem(legacy)!);
				store.removeItem(legacy);
				break;
			}
		} catch {
			// Unavailable storage leaves both scopes as they were.
		}
	}
	return scope;
}

const MODES = [{ id: "ace", name: "Ace", placeholder: "Start a new channel" }];

export function Dashboard(
	{
		project,
		repos,
		channels,
		local,
		connected,
		onSetup,
		onInit,
		onProject,
		onOpen,
		onChannel,
		onCreate,
	}: {
		project: AppProject;
		repos: SessionSidebarRepo[];
		channels: Listing[];
		local: boolean;
		connected: boolean;
		/** Offered for a GitHub project with no checkout on this host. */
		onSetup?: () => void;
		onInit: () => Promise<void>;
		onProject: (id: string) => void;
		onOpen: () => void;
		onChannel: (channel: Listing) => void;
		onCreate: (text?: string, onCreated?: () => void) => Promise<void>;
	},
) {
	const composer = useRef<ChatComposerHandle>(null);
	const [busy, setBusy] = useState(false);
	const [scope] = useState(() => adopt(project));
	const needsGit = local && project.git === false;
	const creatable = (local && !needsGit) || !!onSetup;
	const active = channels.filter((channel) => channel.state !== "archived")
		.sort((a, b) => b.created - a.created);
	const hour = new Date().getHours();
	const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

	async function start(text?: string) {
		if (busy) return;
		setBusy(true);
		try {
			await onCreate(text, () => {
				const input = composer.current;
				const doc = input?.get();
				if (input && doc && serialize(doc) === text) input.clear();
			});
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mx-auto min-h-full w-full max-w-[72rem] px-4 pb-12">
			<section className="mx-auto flex max-w-[39rem] flex-col items-center gap-4 pt-10 text-center md:pt-16">
				<ProjectPicker
					repos={repos}
					selectedRepoId={project.id}
					onRepoChange={(repo) => onProject(repo.id)}
					onAddRepo={connected ? onOpen : undefined}
					trigger={
						<button
							type="button"
							aria-label={`Select project, currently ${project.name}`}
							className="group inline-flex max-w-full select-none items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-[background-color,color,box-shadow] hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
						/>
					}
				>
					<span className="truncate">{project.name}</span>
					<IconChevronDown className="size-3 shrink-0" aria-hidden />
				</ProjectPicker>
				<h1 className="text-balance text-display-xs leading-[1.2] font-medium tracking-tight sm:text-display-sm lg:text-display">
					{greeting}
				</h1>
				<p className="max-w-[34rem] text-pretty text-sm leading-[1.55] text-foreground/65">
					{local
						? `What would you like to work on in ${project.name}?`
						: `Catch up on ${project.name}’s channels on ${[...project.hosts].join(", ")}. ${
							onSetup
								? `Set it up on ${here} to start channels here.`
								: "Open a checkout on this host to start channels here."
						}`}
				</p>
				{onSetup && (
					<Button variant="outline" disabled={!connected} onClick={onSetup}>
						Set up on {here}
					</Button>
				)}
			</section>
			{needsGit && (
				<div className="mx-auto mt-9 max-w-[39rem]">
					<InitGit name={project.name} disabled={!connected} onInit={onInit} />
				</div>
			)}
			{creatable && (
				<div className="mx-auto mt-9 max-w-[39rem]">
					<ChatComposer
						ref={composer}
						scope={scope}
						modes={MODES}
						mode="ace"
						mic={false}
						tools={false}
						canAttach={false}
						canStop={false}
						busy={busy}
						submitBusy={busy}
						canSend={connected && !busy}
						clearOnSend={false}
						onSend={({ doc }) => void start(serialize(doc))}
					/>
				</div>
			)}
			<section className="mx-auto mt-10 max-w-[39rem]">
				<div className="mb-3 flex items-center justify-between gap-3">
					<h2 className="text-sm font-medium">{active.length ? "Pick back up" : "Channels"}</h2>
					{creatable && (
						<Button
							size="sm"
							variant="ghost"
							disabled={!connected || busy}
							onClick={() => void start()}
						>
							<IconPlus className="size-3.5" aria-hidden />
							New channel
						</Button>
					)}
				</div>
				{active.length
					? (
						<div className="flex flex-col gap-1">
							{active.map((channel) => (
								<button
									key={channel.id}
									onClick={() => onChannel(channel)}
									className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/30"
								>
									{channel.hosted
										? (
											<IconCloud
												className="size-4 shrink-0 text-muted-foreground"
												aria-label="Hosted channel"
											/>
										)
										: <IconHash className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
									<span className="min-w-0 flex-1">
										<span className="block truncate">{channel.name}</span>
										{channel.summary && (
											<span className="mt-1 line-clamp-2 text-xs leading-5 break-words text-muted-foreground">
												{channel.summary}
											</span>
										)}
									</span>
									{channel.state === "offline" && (
										<span className="text-xs text-muted-foreground">Offline</span>
									)}
								</button>
							))}
						</div>
					)
					: (
						<p className="text-sm text-muted-foreground">
							Your channels in this project will appear here.
						</p>
					)}
			</section>
		</div>
	);
}
