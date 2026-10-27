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

const FILES: Record<string, string> = {
	"README.md": "# acme-shop\n\nThe storefront and checkout for Acme's online shop.\n",
	"src/cart.ts": `export type Line = { sku: string; price: number; quantity: number };

export function subtotal(lines: Line[]): number {
	return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
}

export function total(lines: Line[], discount = 0): number {
	return Math.round((subtotal(lines) - discount) * 100) / 100;
}
`,
	"src/receipt.ts": `import { type Line } from "./cart";

/** Each line's share of the discount, rounded to cents. */
export function receipt(lines: Line[], discount = 0) {
	const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
	return lines.map((line) => {
		const amount = line.price * line.quantity;
		return { ...line, amount: Math.round((amount - (discount * amount) / subtotal) * 100) / 100 };
	});
}
`,
	"src/refund.ts": `export function refund(paid: number, fraction: number): number {
	return Math.round(paid * fraction * 100) / 100;
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

const SEEDS: Seed[] = [
	{
		format: "ace-seed",
		version: 1,
		name: "checkout-totals",
		summary:
			"Fixing checkout totals that disagree with receipts by a cent when an order has a discount and several lines. Moving amounts to integer cents.",
		chats: [{
			model: { provider, modelId },
			items: [
				said(
					"mona",
					"15:02",
					"Support forwarded three receipts where the total is a cent off. All of them have a discount code and more than one line.",
				),
				said(
					OWNER,
					"15:04",
					"I can reproduce it with SPRING10 on a cart with three different items: we charge a cent less than the receipt's lines add up to.",
				),
				said(
					"octocat",
					"15:05",
					"the receipt rounds each line and total() rounds once, so they disagree whenever the discount splits unevenly",
					{ reactions: [{ from: "mona", emoji: "👍" }] },
				),
				said(OWNER, "15:06", "Where exactly do the receipt and total() round differently?", {
					invoke: true,
				}),
				agent(
					"15:07",
					"They round at different points.\n\n- `total()` in `src/cart.ts` subtracts the discount from the raw subtotal and rounds once.\n- `receipt()` in `src/receipt.ts` spreads the discount across lines and rounds each line, so fractions of a cent that `total()` drops once can round up on several lines.\n\nThe smallest fix is to keep amounts in integer cents and spread the discount in whole cents, giving the remainder to the last line. Then the receipt's lines always add up to the total.",
				),
				said(
					"mona",
					"15:09",
					"integer cents gets my vote, that should also fix the refund rounding I saw last week",
					{ reactions: [{ from: "octocat", emoji: "🎉" }, { from: OWNER, emoji: "👍" }] },
				),
				said(
					"hubot",
					"15:11",
					"I'll turn the three receipts from support into test cases once there's a lane",
				),
			],
		}],
	},
	{
		format: "ace-seed",
		version: 1,
		name: "release-notes",
		summary: "Drafting the notes for the 2.4 release, leading with saved carts.",
		chats: [{
			model: { provider, modelId },
			items: [
				said(
					"hubot",
					"14:30",
					"Draft for 2.4 is up in docs/releases/2.4.md, mostly checkout and search changes.",
				),
				said("octocat", "14:32", "can we lead with saved carts? it's the one people asked for", {
					reactions: [{ from: "hubot", emoji: "👍" }],
				}),
				said(
					OWNER,
					"14:35",
					"Turn the merged pull requests since 2.3 into three short highlights for the top of the notes.",
					{ invoke: true },
				),
				agent(
					"14:36",
					"Three highlights for the top of 2.4:\n\n- **Saved carts.** Signed-in shoppers find their cart where they left it, on any device.\n- **Faster search.** Results appear as you type, and small typos still find the right product.\n- **Clearer checkout.** Each line shows its discount, and the total matches the receipt to the cent.",
				),
				said("hubot", "14:38", "Perfect, pasting those in.", {
					reactions: [{ from: "mona", emoji: "❤️" }],
				}),
			],
		}],
	},
];

const TOTALS = "checkout-totals";
const NOTES = "release-notes";

export const SCRIPT: Script = {
	people: {
		mona: { login: "mona", github: "mona" },
		octocat: { login: "octocat", github: "octocat" },
		hubot: { login: "hubot", github: "hubot" },
	},
	steps: [
		{ at: 0, who: "mona", open: true, channel: TOTALS },
		{ at: 1, who: "octocat", open: true, channel: TOTALS },
		{ at: 2, who: "hubot", open: true, channel: NOTES },
		{ at: 3, who: "mona", type: 5, channel: TOTALS },
		{
			at: 8,
			who: "mona",
			say: "pushed the integer cents change to my lane, can someone look before I open the PR?",
			channel: TOTALS,
		},
		{ at: 10, who: "octocat", react: "👀", channel: TOTALS },
		{ at: 11, who: "octocat", type: 5, channel: TOTALS },
		{
			at: 16,
			who: "octocat",
			ask: "Does the cents change still handle a discount larger than the subtotal?",
			thinking:
				"Read total() and receipt() for a discount above the subtotal, then check what else still rounds in dollars.",
			reply:
				"Yes. `total()` now clamps at zero, so a discount larger than the subtotal leaves a total of 0 cents instead of a negative amount, and `receipt()` gives the remainder to the last line so the lines still add up.\n\nOne gap: `refund()` in `src/refund.ts` still works in dollars, so a partial refund of a discounted order can be a cent off. Converting it the same way would close that.",
			channel: TOTALS,
		},
		{ at: 20, who: "hubot", type: 4, channel: NOTES },
		{
			at: 24,
			who: "hubot",
			say: "moved saved carts to the top, the notes are ready for a look",
			channel: NOTES,
		},
		{ at: 30, who: "mona", type: 4, channel: TOTALS },
		{
			at: 34,
			who: "mona",
			say: "good catch on refund(), I'll convert it in the same lane",
			channel: TOTALS,
		},
		{ at: 36, who: "hubot", open: true, channel: TOTALS },
		{ at: 37, who: "hubot", react: "🎉", channel: TOTALS },
		{ at: 39, who: "hubot", type: 4, channel: TOTALS },
		{
			at: 43,
			who: "hubot",
			say: "I'll point the three support receipts at that lane as tests",
			channel: TOTALS,
		},
		{ at: 45, who: "octocat", react: "👍", channel: TOTALS },
		{ at: 50, who: "mona", away: true },
		{ at: 54, who: "octocat", close: true, channel: TOTALS },
		{ at: 55, who: "octocat", open: true, channel: NOTES },
		{ at: 56, who: "octocat", type: 3, channel: NOTES },
		{ at: 59, who: "octocat", say: "notes look good to me", channel: NOTES },
		{ at: 60, who: "hubot", react: "🚀", channel: NOTES },
		{ at: 66, who: "hubot", leave: true },
		{ at: 70, who: "mona", leave: true },
		{ at: 72, who: "octocat", leave: true },
	],
	loop: 15,
};

/** A Git project with the seeded channels in `home`, whose times end now. */
export async function seed(home: string): Promise<void> {
	const dir = join(home, "acme-shop");
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
				"Start acme-shop",
			],
		]
	) {
		const result = await git(dir, args);
		if (result.status !== 0) throw new Error(`Could not set up the demo project: ${result.stderr}`);
	}
	for (const value of SEEDS) await importSeed(value, { dir, now: true, shared: true });
}
