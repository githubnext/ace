/**
 * ace demo's data: a clone of Beats, channels seeded with a team's conversation, and the script its
 * teammates follow. The conversation is made up and lives only in the demo's throwaway home.
 */
import { join } from "node:path";

import { AssistantEntry } from "@earendil-works/pi-durable";

import type { Seed, SeedItem } from "@ace/channel";
import type { Reaction } from "@ace/channel/protocol";

import type { Script } from "./demo";
import { DEMO_MODEL } from "./demo-model";
import { git } from "./projects";
import { importSeed } from "./seed";

import BEATS from "./demo-beats.jpg" with { type: "file" };

/**
 * The owner's login in the demo. Avatars come from GitHub, and GitHub's deleted-user placeholder is
 * the one login that shows no real person's face.
 */
export const OWNER = "ghost";

const [provider, modelId] = DEMO_MODEL.split("/") as [string, string];

const PROJECT = "beats-demo";

/** Beats, the drum machine the demo's team works on, which needs access to githubnext. */
const SOURCE = "https://github.com/githubnext/beats-demo.git";

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
const THEME = "add-dark-theme";

const SEEDS: Seed[] = [
	{
		format: "ace-seed",
		version: 1,
		name: DELAY,
		summary: "A tempo-synced delay for Beats: added in #6, pulled in #7, maybe coming back.",
		chats: [{
			model: { provider, modelId },
			items: [
				said(
					"idan",
					"15:02",
					"Can we get a delay on Beats? Something that follows the tempo.",
				),
				said(
					"agorischek",
					"15:04",
					"yes, and it should follow the tempo keys live, not only when you hit play",
				),
				said(
					"davidslater",
					"15:05",
					"keep feedback under 1 or it runs away and blows out everyone's speakers 😅",
					{ reactions: [{ from: "idan", emoji: "😂" }] },
				),
				said(
					"agorischek",
					"15:06",
					"Add a tempo-synced delay with a knob next to the tempo keys, and socket control.",
					{ invoke: true },
				),
				agent(
					"15:07",
					"Here's the plan for `Sources/main.swift`:\n\n- A `StereoDelay` whose buffers are allocated once, never in the render callback.\n- Its read head sits an eighth note back at the current BPM, `rate * 30 / bpm`, smoothed over 20 ms so a tempo change glides instead of clicking.\n- Feedback fixed at 0.4, so repeats always die out.\n- A DELAY knob beside the tempo keys, and `delay` on `bin/beats` for agents.",
				),
				said(
					"idan",
					"15:09",
					"gliding the delay time is a nice touch, it'll smear like tape when you change the tempo",
					{
						reactions: [{ from: "davidslater", emoji: "🎉" }, { from: "agorischek", emoji: "👍" }],
					},
				),
				said(
					"agorischek",
					"15:40",
					"pulled the delay out for now in #7, it's all in the history if we want it back",
				),
			],
		}],
	},
	// Empty, so the team's whole conversation plays live.
	{
		format: "ace-seed",
		version: 1,
		name: THEME,
		summary: "A dark theme for Beats.",
		chats: [{ model: { provider, modelId }, items: [] }],
	},
];

const PALETTE = `python3 - <<'EOF'
p='Sources/main.swift'
s=open(p).read()
old=s[s.index('// After Tee'):s.index('// Dark accents')]
new='''// Synthwave: a midnight-purple body and violet plate, a black display, and keys in neon pink,
// cyan, violet and sunset orange that glow against the dark.
let body = hex(0x1a1033)
let plate = hex(0x2a1b4d)
let keyLight = hex(0x3a2766)
let keyShadow = hex(0x0d0820)
let ink = hex(0xf5d0fe)
let muted = hex(0x9d7cc9)
let ledOff = hex(0x4a3670)
let screenFill = hex(0x07040f)
let ghost = hex(0x1b1230)
let orange = hex(0xff2bd6)
let accents = [orange, hex(0x22d3ee), hex(0xa855f7), hex(0xf472b6), hex(0x7c3aed), hex(0x38bdf8), hex(0xfb923c), hex(0xfde047)]

'''
open(p,'w').write(s.replace(old,new))
EOF`;

export const SCRIPT: Script = {
	people: {
		idan: { login: "idan", github: "idan" },
		davidslater: { login: "davidslater", github: "davidslater" },
		agorischek: { login: "agorischek", github: "agorischek" },
	},
	steps: [
		{ at: 0, who: "idan", open: true, channel: THEME },
		{ at: 1, who: "davidslater", open: true, channel: THEME },
		{ at: 1, who: "agorischek", open: true, channel: THEME },
		{ at: 2, who: "idan", type: 4, channel: THEME },
		{
			at: 6,
			who: "idan",
			say: "We should add a dark theme to the synth. Any ideas of what style we should go for?",
			image: BEATS,
			channel: THEME,
		},
		{ at: 8, who: "davidslater", type: 3, channel: THEME },
		{ at: 11, who: "davidslater", say: "hmmm, how about something retro", channel: THEME },
		{ at: 12, who: "agorischek", type: 2, channel: THEME },
		{ at: 14, who: "agorischek", say: "i vote synthwave", channel: THEME },
		{ at: 15, who: "davidslater", react: "👍", channel: THEME },
		{ at: 16, who: "davidslater", type: 2, channel: THEME },
		{ at: 18, who: "davidslater", say: "love it", channel: THEME },
		{ at: 19, who: "idan", type: 2, channel: THEME },
		{ at: 21, who: "idan", say: "oooh yeah!", channel: THEME },
		{ at: 22, who: "davidslater", type: 2, channel: THEME },
		{
			at: 24,
			who: "davidslater",
			ask: "do it",
			work: [
				{ calls: [{ tool: "lane", args: { action: "start", name: "synthwave-theme" } }] },
				{
					calls: [{
						tool: "bash",
						args: {
							command:
								'cat .agents/skills/lane/SKILL.md | head -80; ls; wc -l Sources/main.swift; ls -R .lane/memory 2>/dev/null || echo "no lane memory yet"',
						},
					}],
				},
				{ calls: [{ tool: "read", args: { path: "Sources/main.swift" } }] },
				{
					calls: [{
						tool: "bash",
						args: {
							command:
								"cat Package.swift Makefile; cat README.md; cat bin/beats; git log --oneline | head",
						},
					}],
				},
				{
					say:
						"Every color Beats draws comes from one palette at the top of `Sources/main.swift`. Swapping it for synthwave:",
					calls: [{ tool: "bash", args: { command: PALETTE } }],
				},
			],
			reply:
				"Synthwave is on the `synthwave-theme` lane. I swapped the EP-133 palette at the top of `Sources/main.swift` for:\n\n- a midnight-purple body (`#1a1033`) and violet label plate\n- dark violet keys with pale lilac ink\n- neon pink (`#ff2bd6`) in place of TE orange, so the playhead, the BEATS tab and the step LEDs glow pink\n- track colors in pink, cyan, violet, sky blue, sunset orange and yellow\n\nThe names stay the same, so nothing else changes. Run `make run` in the lane to see it.",
			channel: THEME,
		},
		{ at: 45, who: "idan", open: true, channel: DELAY },
		{ at: 46, who: "agorischek", open: true, channel: DELAY },
		{ at: 47, who: "idan", type: 4, channel: DELAY },
		{
			at: 51,
			who: "idan",
			say:
				"went back through #6, honestly I miss the delay. the smear when you change the tempo was the best part",
			channel: DELAY,
		},
		{ at: 53, who: "agorischek", react: "🔥", channel: DELAY },
		{ at: 54, who: "davidslater", open: true, channel: DELAY },
		{ at: 55, who: "davidslater", type: 4, channel: DELAY },
		{
			at: 59,
			who: "davidslater",
			ask:
				"If we bring the delay back, does it stay in time when someone changes the tempo mid-pattern?",
			thinking:
				"Find the delay in the history, then check how it follows a tempo change and what happens to repeats already in its buffer.",
			work: [
				{
					say: "Finding the delay in the history.",
					calls: [{
						tool: "bash",
						args: { command: "git log --oneline -S StereoDelay -- Sources/main.swift" },
					}],
				},
				{
					calls: [{
						tool: "bash",
						args: {
							command:
								"git show 156ff62:Sources/main.swift | grep -n 'length +=\\|smoothing =\\|wet[LR] \\* 0.4'",
						},
					}],
				},
				{
					say:
						"It glides the read head instead of jumping. Working out how long repeats already in the buffer take to fade at its feedback of 0.4:",
					calls: [{
						tool: "bash",
						args: {
							command:
								"awk 'BEGIN { n = log(10^(-30/20)) / log(0.4); printf \"%.1f repeats, %.2f s at 120 BPM\\n\", n, n * 30 / 120 }'",
						},
					}],
				},
			],
			reply:
				"Yes. The `StereoDelay` from 156ff62 never jumps its read head: every sample it glides toward an eighth note at the new BPM, `rate * 30 / bpm`, with a 20 ms smoother, so new repeats land on the new grid within about 100 ms. Repeats already in the buffer keep their old spacing until they fade: feedback is fixed at 0.4, so they drop 30 dB in about four repeats, under a second at 120 BPM.\n\nReverting 962797b brings it back as it was.",
			channel: DELAY,
		},
		{ at: 75, who: "agorischek", type: 3, channel: DELAY },
		{
			at: 78,
			who: "agorischek",
			say: "let's bring it back once synthwave lands. both together will be very 1986",
			channel: DELAY,
		},
		{ at: 80, who: "idan", react: "😎", channel: DELAY },
		{ at: 90, who: "idan", away: true },
	],
};

/** The seeded project's folder in `home`. */
export function seeded(home: string): string {
	return join(home, PROJECT);
}

/** A clone of Beats from `source`, or GitHub, with the seeded channels in `home`, ending now. */
export async function seed(home: string, source = SOURCE): Promise<void> {
	const dir = seeded(home);
	const result = await git(home, ["clone", "-q", source, PROJECT]);
	if (result.status !== 0) throw new Error(`Could not clone ${source}: ${result.stderr}`);
	for (const value of SEEDS) await importSeed(value, { dir, now: true, shared: true });
}
