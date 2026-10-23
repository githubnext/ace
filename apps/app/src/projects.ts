import { checkoutId, type Listing, type Project, projectId, root } from "@ace/host/protocol";

/**
 * `host` and `path` are the checkout that creates channels and reads GitHub: this host's own
 * checkout when it has one, else one whose host can answer for it. `reachable` is whether it can:
 * a peer answers only for a project its own listing shows a live channel in.
 * `checkouts` holds every known checkout's ID on any host. `label` is `name`, unique among
 * projects shown alike.
 */
export type AppProject = Project & {
	id: string;
	label: string;
	host: string;
	reachable: boolean;
	hosts: Set<string>;
	checkouts: Set<string>;
};

/**
 * A GitHub project is the same project wherever it is checked out. A folder without one is only
 * its host's, so a folder elsewhere is named by the hosts that have it.
 */
const hosts = (project: AppProject, host: string) =>
	project.repo || project.host === host ? "" : ` · ${[...project.hosts].join(", ")}`;

export const label = (project: AppProject, host: string) => project.label + hosts(project, host);

/** The full checkout behind a label, for hover. */
export const title = (project: AppProject, host: string) =>
	project.host === host ? project.path : `${project.path} on ${project.host}`;

/**
 * Like VS Code's editor tabs, projects shown alike gain the fewest trailing parent folders that
 * tell them apart, or the owner for a GitHub project, whose checkout is not its identity.
 */
function disambiguate(values: AppProject[], host: string) {
	const alike = new Map<string, AppProject[]>();
	for (const value of values) {
		const key = value.name + hosts(value, host);
		const list = alike.get(key);
		if (list) list.push(value);
		else alike.set(key, [value]);
	}
	for (const list of alike.values()) {
		if (list.length < 2) continue;
		const parents = list.map((value) =>
			value.repo
				? [value.repo.split("/")[0]!]
				: value.path.replace(/\/+$/, "").split("/").slice(0, -1).filter(Boolean)
		);
		list.forEach((value, index) => {
			const own = parents[index]!;
			let count = 1;
			while (
				count < own.length
				&& parents.some((other, at) =>
					at !== index && other.slice(-count).join("/") === own.slice(-count).join("/")
				)
			) count++;
			value.label = `${value.name} — ${own.slice(-count).join("/") || "/"}`;
		});
	}
}

export function projects(opened: Project[], channels: Listing[], host: string): AppProject[] {
	const values = new Map<string, AppProject>();
	const rank = (at: string, reachable: boolean) => at === host ? 2 : reachable ? 1 : 0;
	function add(
		at: string,
		path: string,
		name: string,
		reachable: boolean,
		repo?: string,
		opened?: Project,
	) {
		const id = projectId(at, path, repo);
		const checkout = checkoutId(at, path);
		const value = values.get(id);
		if (!value) {
			const created: AppProject = {
				id,
				host: at,
				path,
				name,
				label: name,
				reachable,
				hosts: new Set([at]),
				checkouts: new Set([checkout]),
			};
			if (repo) created.repo = repo;
			if (opened?.git === false) created.git = false;
			if (opened?.empty) created.empty = true;
			if (opened?.ignored) created.ignored = true;
			return void values.set(id, created);
		}
		value.hosts.add(at);
		value.checkouts.add(checkout);
		if (rank(at, reachable) <= rank(value.host, value.reachable)) return;
		value.host = at;
		value.path = path;
		value.reachable = reachable;
	}
	if (host) {
		for (const project of opened) {
			add(host, project.path, project.name, true, project.repo, project);
		}
	}
	// Creation order, not the host's: a peer's listings move behind the directory's while it is
	// offline, which would re-sort projects known only through its channels.
	const ordered = [...channels].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
	for (const channel of ordered) {
		const path = root(channel);
		const name = channel.repo?.split("/")[1] || path.replace(/\/+$/, "").split("/").pop() || path;
		// Directory-only listings are offline or archived, and a hosted channel's host is a workspace.
		const reachable = channel.host === host
			|| !channel.hosted && (channel.state === "running" || channel.state === "dormant");
		add(channel.host, path, name, reachable, channel.repo);
	}
	const found = [...values.values()];
	disambiguate(found, host);
	return found;
}
