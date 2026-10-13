import type { Listing, Project } from "@ace/host/protocol";

/**
 * `host` and `path` are the checkout that creates channels and reads GitHub: this host's own
 * checkout when it has one. `checkouts` holds every known checkout's ID on any host.
 */
export type AppProject = Project & {
	id: string;
	host: string;
	hosts: Set<string>;
	checkouts: Set<string>;
};

/** Hosts before project roots list each checkout as its own project. */
export const root = (channel: Pick<Listing, "project" | "root">) => channel.root || channel.project;

/** Also the project ID that earlier app versions saved for every project. */
export const checkoutId = (host: string, path: string) => JSON.stringify([host, path]);

/**
 * GitHub repository names are case-insensitive and hosts already strip `.git`, so every checkout
 * of one repository is one project. A folder without a GitHub remote belongs to its host.
 */
export const projectId = (host: string, path: string, repo?: string) =>
	repo ? `github:${repo.toLowerCase()}` : checkoutId(host, path);

export const channelProject = (channel: Pick<Listing, "host" | "project" | "root" | "repo">) =>
	projectId(channel.host, root(channel), channel.repo);

/**
 * A GitHub project is the same project wherever it is checked out. A folder without one is only
 * its host's, so a folder elsewhere is named by the hosts that have it.
 */
export const label = (project: AppProject, host: string) =>
	project.repo || project.host === host
		? project.name
		: `${project.name} · ${[...project.hosts].join(", ")}`;

export function projects(opened: Project[], channels: Listing[], host: string): AppProject[] {
	const values = new Map<string, AppProject>();
	function add(at: string, path: string, name: string, repo?: string, git?: false) {
		const id = projectId(at, path, repo);
		const checkout = checkoutId(at, path);
		const value = values.get(id);
		if (!value) {
			const created: AppProject = {
				id,
				host: at,
				path,
				name,
				hosts: new Set([at]),
				checkouts: new Set([checkout]),
			};
			if (repo) created.repo = repo;
			if (git === false) created.git = git;
			return void values.set(id, created);
		}
		value.hosts.add(at);
		value.checkouts.add(checkout);
		if (value.host === host || at !== host) return;
		value.host = at;
		value.path = path;
	}
	if (host) {
		for (const project of opened) {
			add(host, project.path, project.name, project.repo, project.git);
		}
	}
	for (const channel of channels) {
		const path = root(channel);
		const name = channel.repo?.split("/")[1] || path.replace(/\/+$/, "").split("/").pop() || path;
		add(channel.host, path, name, channel.repo);
	}
	return [...values.values()];
}
