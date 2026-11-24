/**
 * ace demo's mocked data: a small project, channels seeded with a team's conversation, and the
 * script its teammates follow. Everything is made up and lives only in the demo's throwaway home.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { AssistantEntry } from "@earendil-works/pi-durable";

import type { Seed, SeedItem } from "@ace/channel";
import type { Reaction } from "@ace/channel/protocol";

import type { Script } from "./demo";
import { DEMO_MODEL } from "./demo-model";
import { git } from "./projects";
import { importSeed } from "./seed";

/**
 * The owner's login in the demo, so seeded messages can be theirs. Avatars come from GitHub, and
 * GitHub's deleted-user placeholder is the one login that shows no real person's face.
 */
export const OWNER = "ghost";

const [provider, modelId] = DEMO_MODEL.split("/") as [string, string];

const PROJECT = "beats-demo";

const FILES: Record<string, string> = {
	"README.md":
		"# beats-demo\n\nA browser drum machine: a 16-step sequencer on the Web Audio API.\n",
	"src/engine.ts": `export const STEPS = 16;

export type Track = { name: string; sample: AudioBuffer; steps: boolean[] };

/** Schedules a step ahead of the audio clock, so timing never waits on the UI thread. */
export function schedule(
	context: AudioContext,
	tracks: Track[],
	step: number,
	at: number,
	out: AudioNode,
): void {
	for (const track of tracks) {
		if (!track.steps[step]) continue;
		const source = context.createBufferSource();
		source.buffer = track.sample;
		source.connect(out);
		source.start(at);
	}
}

/** A sixteenth note at this tempo, in seconds. */
export function sixteenth(bpm: number): number {
	return 60 / bpm / 4;
}
`,
	"src/effects.ts":
		`/** The master chain: everything the tracks play goes through here to the speakers. */
export function master(context: AudioContext): GainNode {
	const input = context.createGain();
	const compressor = context.createDynamicsCompressor();
	input.connect(compressor).connect(context.destination);
	return input;
}
`,
	"src/theme.css": `:root {
	--background: #f5f5f4;
	--pad: #d6d3d1;
	--pad-on: #2563eb;
	--text: #1c1917;
	font-family: system-ui, sans-serif;
}

.pad {
	background: var(--pad);
	border-radius: 4px;
}

.pad[data-on] {
	background: var(--pad-on);
}
`,
};

function said(
	author: string,
	at: string,
	text: string,
	extra: { invoke?: boolean; reactions?: Reaction[] } = {},
): SeedItem {
	return { author, at: `2026-01-15T${at}:00Z`, text, ...extra };
}

function agent(at: string, text: string): SeedItem {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		agent: {
			kind: AssistantEntry.kind,
			model: [{
				role: "assistant",
				content: [{ type: "text", text }],
				api: provider,
				provider,
				model: modelId,
				usage: { ...usage, totalTokens: 0, cost: { ...usage, total: 0 } },
				stopReason: "stop",
				timestamp: Date.parse(`2026-01-15T${at}:00Z`),
			}],
		},
	};
}

const DELAY = "delay-effect";
const THEME = "synthwave-theme";

const SEEDS: Seed[] = [
	{
		format: "ace-seed",
		version: 1,
		name: DELAY,
		summary: "Adding a tempo-synced delay to the master chain, with feedback and mix controls.",
		chats: [{
			model: { provider, modelId },
			items: [
				said(
					"idan",
					"15:02",
					"Can we get a delay on the master? Something like a dotted eighth that follows the tempo.",
				),
				said(
					OWNER,
					"15:04",
					"yes, and it should follow the BPM slider live, not only when you hit play",
				),
				said(
					"davidslater",
					"15:05",
					"keep feedback under 1 or it runs away and blows out everyone's speakers 😅",
					{ reactions: [{ from: "idan", emoji: "😂" }] },
				),
				said(
					OWNER,
					"15:06",
					"Add a tempo-synced delay to the master chain with feedback and mix controls.",
					{ invoke: true },
				),
				agent(
					"15:07",
					"Here's the plan for `src/effects.ts`:\n\n- A `DelayNode` whose `delayTime` is a dotted eighth at the current tempo, `0.75 * 60 / bpm`.\n- A feedback `GainNode` from the delay back into itself, capped at 0.9 so repeats always die out.\n- Dry and wet gains for the mix, both feeding the compressor.\n\n`setTempo(bpm)` ramps `delayTime` with `setTargetAtTime`, so dragging the BPM slider doesn't click.",
				),
				said(
					"idan",
					"15:09",
					"ramping the delay time is a nice touch, it'll smear like tape when you drag the tempo",
					{ reactions: [{ from: "davidslater", emoji: "🎉" }, { from: OWNER, emoji: "👍" }] },
				),
				said(
					"davidslater",
					"15:11",
					"I'll put a mix knob next to the BPM slider once there's a lane",
				),
			],
		}],
	},
	{
		format: "ace-seed",
		version: 1,
		name: THEME,
		summary: "Restyling the sequencer in a synthwave theme: neon pads on a dark grid.",
		chats: [{
			model: { provider, modelId },
			items: [
				said(
					"davidslater",
					"14:30",
					"Synthwave mockup is up: dark purple, neon pink and cyan, a grid floor fading behind the pads.",
				),
				said(
					"idan",
					"14:32",
					"love it. can the playing step glow? pads lighting up as the playhead passes",
					{ reactions: [{ from: "davidslater", emoji: "👍" }] },
				),
				said(OWNER, "14:35", "Turn the synthwave mockup into theme tokens for src/theme.css.", {
					invoke: true,
				}),
				agent(
					"14:36",
					"Synthwave tokens for `src/theme.css`:\n\n- `--background: #1a1033`, with a magenta-to-cyan grid fading toward the horizon\n- `--pad: #2d1b4e` and `--pad-on: #ff2bd6`, neon pink\n- `--playhead: #22d3ee`, cyan, for the step that's playing\n- `--glow: 0 0 12px var(--pad-on)` on active pads\n- `--text: #f5d0fe` in a wide monospace\n\nThe token names stay the same as the light theme's, so the sequencer's markup doesn't change.",
				),
				said("davidslater", "14:38", "Perfect, wiring those in.", {
					reactions: [{ from: "idan", emoji: "❤️" }],
				}),
			],
		}],
	},
];

export const SCRIPT: Script = {
	people: {
		idan: { login: "idan", github: "idan" },
		davidslater: { login: "davidslater", github: "davidslater" },
	},
	steps: [
		{ at: 0, who: "idan", open: true, channel: DELAY },
		{ at: 1, who: "davidslater", open: true, channel: DELAY },
		{ at: 3, who: "idan", type: 5, channel: DELAY },
		{
			at: 8,
			who: "idan",
			say: "pushed the delay to my lane, try it on the 808 pattern at 120",
			channel: DELAY,
		},
		{ at: 10, who: "davidslater", react: "🔥", channel: DELAY },
		{ at: 11, who: "davidslater", type: 5, channel: DELAY },
		{
			at: 16,
			who: "davidslater",
			ask: "Does the delay stay in time if someone changes the tempo mid-pattern?",
			thinking:
				"Check how setTempo updates the delay time, and what happens to repeats already in the feedback loop.",
			reply:
				"Yes. `setTempo()` ramps `delayTime` to the new dotted eighth over about 50 ms, so new repeats land on the new grid right away. Repeats already in the feedback loop keep their old spacing until they fade, which takes under a second at the default feedback of 0.4.\n\nFor a hard cut instead, `setTempo()` could dip the wet gain to zero during the ramp.",
			channel: DELAY,
		},
		{ at: 22, who: "davidslater", open: true, channel: THEME },
		{ at: 23, who: "davidslater", type: 4, channel: THEME },
		{
			at: 27,
			who: "davidslater",
			say: "playhead glow is in, the pads pulse cyan as it passes",
			channel: THEME,
		},
		{ at: 30, who: "idan", type: 4, channel: DELAY },
		{
			at: 34,
			who: "idan",
			say: "honestly the smear when you drag the tempo is my favorite part, let's keep it",
			channel: DELAY,
		},
		{ at: 36, who: "davidslater", open: true, channel: DELAY },
		{ at: 37, who: "davidslater", react: "🎉", channel: DELAY },
		{ at: 39, who: "davidslater", type: 4, channel: DELAY },
		{
			at: 43,
			who: "davidslater",
			say: "delay plus the synthwave theme together is very 1986, I'm into it",
			channel: DELAY,
		},
		{ at: 45, who: "idan", react: "😎", channel: DELAY },
		{ at: 50, who: "idan", open: true, channel: THEME },
		{ at: 51, who: "idan", type: 3, channel: THEME },
		{ at: 54, who: "idan", say: "the neon pink on active pads is perfect", channel: THEME },
		{ at: 56, who: "davidslater", react: "🚀", channel: THEME },
		{ at: 62, who: "idan", away: true },
		{ at: 66, who: "davidslater", leave: true },
		{ at: 70, who: "idan", leave: true },
	],
	loop: 15,
};

/** A Git project with the seeded channels in `home`, whose times end now. */
export async function seed(home: string): Promise<void> {
	const dir = join(home, PROJECT);
	for (const [path, text] of Object.entries(FILES)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	// The person's own Git config may sign commits or run hooks, which a demo must not need.
	const commit = ["-c", "user.name=Ace demo", "-c", "user.email=demo@ace.invalid"];
	for (
		const args of [
			["init", "-q", "-b", "main"],
			["add", "."],
			[
				...commit,
				"-c",
				"commit.gpgsign=false",
				"commit",
				"-q",
				"--no-verify",
				"-m",
				`Start ${PROJECT}`,
			],
		]
	) {
		const result = await git(dir, args);
		if (result.status !== 0) throw new Error(`Could not set up the demo project: ${result.stderr}`);
	}
	for (const value of SEEDS) await importSeed(value, { dir, now: true, shared: true });
}
