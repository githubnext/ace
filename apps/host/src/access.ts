/**
 * Project access (docs/terms.md): direct for a GitHub repository a person can read or a folder on
 * their own host, otherwise through a share in the team's directory. It is cooperative: peers
 * report their owners' GitHub logins unchecked (docs/architecture.md, The team).
 */
import { hostname } from "node:os";

import * as catalog from "./catalog";
import * as directory from "./directory";
import * as github from "./github";
import { failure, log } from "./log";
import * as peers from "./peers";
import { type Person, type ProjectAccess, TEAM } from "./protocol";

/** Listings check access on every frame, so GitHub's answers are kept for a while. */
const FRESH = 5 * 60_000;
/** A check GitHub couldn't answer refuses access until it is asked again. */
const RETRY = 60_000;

let host = hostname();

/** This host's tailnet name, which its own folders' project IDs carry. */
export function identify(name: string): void {
	host = name;
}

const checks = new Map<string, { at: number; ttl: number; value: Promise<boolean> }>();

function readable(repo: string, login?: string): Promise<boolean> {
	const key = `${repo} ${login?.toLowerCase()}`;
	const cached = checks.get(key);
	if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
	const entry = {
		at: Date.now(),
		ttl: FRESH,
		value: github.readable(repo, login).catch((error) => {
			entry.ttl = RETRY;
			log("warn", "access.github", { repo, login, ...failure(error) });
			return false;
		}),
	};
	checks.set(key, entry);
	return entry.value;
}

/** A person's GitHub login: this host's own from gh, others' as their hosts last reported. */
function githubOf(person: string): string | undefined {
	if (person === catalog.user) return github.known();
	return peers.people()[person]
		|| directory.read().hosts.find((value) => value.login === person && value.github)?.github;
}

function ownerOf(name: string): string | undefined {
	if (name === host) return catalog.user;
	return peers.machine(name)?.login
		|| directory.read().hosts.find((value) => value.name === name)?.login;
}

/** Direct access is what lets a person share or unshare a project. */
async function via(person: string, project: string): Promise<Person["via"] | undefined> {
	if (project.startsWith("github:")) {
		const isReadable = await readable(project.slice("github:".length), githubOf(person));
		return isReadable ? "github" : undefined;
	}
	const [folder] = JSON.parse(project) as [string, string];
	return ownerOf(folder) === person ? "folder" : undefined;
}

export async function isDirect(person: string, project: string): Promise<boolean> {
	return !!await via(person, project);
}

function shared(person: string, project: string): Person["via"] | undefined {
	let found: Person["via"] | undefined;
	for (const share of directory.read().shares) {
		if (share.project !== project) continue;
		if (share.person === TEAM) found = "team";
		else if (share.person === person) return "share";
	}
	return found;
}

export async function canAccess(person: string, project: string): Promise<boolean> {
	return !!shared(person, project) || isDirect(person, project);
}

/** The team's people this host knows, by Tailscale login. */
function team(): Set<string> {
	const people = new Set([catalog.user, ...Object.keys(peers.people())]);
	for (const value of directory.read().hosts) people.add(value.login);
	return people;
}

/** Who on the team can see a project and why, for its owner's Share dialog. */
export async function describe(project: string): Promise<ProjectAccess> {
	const people = await Promise.all([...team()].map(async (person): Promise<Person | undefined> => {
		const reason = await via(person, project) || shared(person, project);
		return reason && { person, github: githubOf(person), via: reason };
	}));
	return {
		direct: await isDirect(catalog.user, project),
		shares: directory.read().shares.filter((share) => share.project === project),
		people: people.filter((value) => !!value),
	};
}

/** Only people with direct access share, so access from a share is never passed on. */
export async function share(project: string, person: string, isShared: boolean): Promise<void> {
	if (!await isDirect(catalog.user, project)) {
		throw new Error(
			"Only people who can read the project on GitHub, or whose folder it is, can share it",
		);
	}
	await directory.share({ project, person, by: catalog.user }, isShared);
}
