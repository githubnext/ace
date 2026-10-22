import {
	type AssistantMessage,
	getSupportedThinkingLevels,
	isContextOverflow,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type AgentEvent,
	type CommitChange,
	type Conversation,
	type ConversationId,
	type ConversationRecord,
	createRegistry,
	type Cursor,
	defineDoc,
	defineExtension,
	type EntryId,
	type EntryRecord,
	Harness,
	InboxDoc,
	type InboxState,
	LiveDoc,
	type LiveState,
	ROOT_CONVERSATION_ID,
	type Storage,
	type SubmissionId,
	type SubmissionRecord,
	ToolResultEntry,
	UsageDoc,
	type UsageState,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { type Directory, messaging, subagent } from "./agents";
import { type Browser, browser } from "./browser";
import {
	caption,
	CaptionsDoc,
	FAST,
	isStale,
	pick,
	recap,
	segments,
	spend,
	STRONG,
} from "./captions";
import { instructions } from "./context";
import { changes, fetchBase, patch } from "./changes";
import { type Desktop, desktop } from "./desktop";
import { HANDOFF, Handoffs } from "./handoffs";
import { type Images, images } from "./images";
import { lanes, LanesDoc } from "./lanes";
import { failure, type Log, logging, scoped } from "./log";
import {
	DeletionEntry,
	edit,
	EditEntry,
	type Messages,
	MessagesDoc,
	react,
	remove,
} from "./messages";
import { metadata, MetadataDoc, validateName } from "./metadata";
import { available, choose, usable } from "./models";
import { progress } from "./progress";
import { answer, Questions } from "./questions";
import type {
	ChannelInfo,
	Chat,
	ChatId,
	Effort,
	Event,
	Metadata,
	ModelRef,
	Request,
	RunEnd,
	Said,
	Usage,
} from "./protocol";
import { MENTION } from "./protocol";
import { queue, withdrawn } from "./queue";
import * as room from "./room";
import { exportSeed, importSeed, type Seed } from "./seed";
import { type Tabs, tabs } from "./tabs";

type Settings = { shared: boolean; desktop: boolean };

const SettingsDoc = defineDoc<Settings>({
	kind: "ace.settings",
	version: 2,
	scope: "session",
	initial: () => ({ shared: false, desktop: false }),
	migrate: (value) => ({ shared: value.shared as boolean, desktop: true }),
});

/** Channels created before new channels started unshared store no settings and stay shared. */
const LEGACY: Settings = { shared: true, desktop: true };

/** Inactivity is measured in hours, so activity is published at most this often. */
const ACTIVITY_INTERVAL = 5 * 60_000;

export type Options = {
	id: string;
	name: string;
	/** Existing and explicitly named channels keep their name until a requested rename. */
	named?: boolean;
	/** Immutable Git branch prefix, seeded from the channel's initial name. */
	prefix?: string;
	owner: string;
	/** Paths inside the execution environment's file system. */
	project: string;
	model?: ModelRef;
	/**
	 * The lane a forked channel's root chat starts in, recorded only in the commit that creates the
	 * root chat, so reopening never moves a chat that has since switched lanes.
	 */
	lane?: { name: string; path: string; base: string };
	/** The host's current preference, consulted only for a chat's first agent invocation. */
	defaultModel?(): Promise<ModelRef>;
	storage: Storage;
	models: Models;
	env(cwd: string): ExecutionEnv;
	desktop?: Desktop;
	browser?: Browser;
	images?: Images;
	tabs?: Tabs;
	directory: Directory;
	/**
	 * Reserve a new name among the runtime's channels: `exact` refuses a taken name, otherwise the
	 * name actually reserved comes back numbered. Hosted channels cannot see other channels yet.
	 */
	claim?(name: string, exact: boolean): Promise<string>;
	/** Publish a projection of committed metadata to the runtime's channel catalog. */
	onMetadata?(value: Metadata): void;
	/** Publish when the transcript last grew, in epoch milliseconds. */
	onActivity?(at: number): void;
	/** Rebuildable channel-wide projection of pi live runs, including child chats. */
	onBusy?(busy: boolean): void;
	/** Publish each run a person invoked as it ends, for their attention. */
	onRun?(run: RunEnd): void;
	/** Publish each message people and other channels' agents write, for teammates' attention. */
	onSaid?(said: Said): void;
	log: Log;
};

type Send = (event: Event) => void;
/** `reacted` once a reactions event, which carries the chat's whole state, has been sent. */
type Listener = {
	chat: ChatId;
	send: Send;
	captions: boolean;
	actions: boolean;
	reacted?: boolean;
};

export class Channel {
	#options: Options;
	#harness: Harness;
	#log: Log;
	#metadata: Metadata;
	/** Committed settings, maintained from pi's commit stream before native dispatch. */
	#settings: Settings;
	#active = 0;
	/** Each live run's inputs, from pi's `LiveDoc`. */
	#runs = new Map<ConversationId, readonly SubmissionId[]>();
	#publishedBusy?: boolean;
	#unsubscribe?: () => void;
	#admissions = new Map<ChatId, Promise<unknown>>();
	#listeners = new Set<Listener>();
	/** Chats with a captioning pass in progress; `true` when another pass must follow it. */
	#captioning = new Map<ConversationId, boolean>();
	#closing = new AbortController();

	private constructor(
		options: Options,
		harness: Harness,
		log: Log,
		value: Metadata,
		settings: Settings,
	) {
		this.#options = options;
		this.#harness = harness;
		this.#log = log;
		this.#metadata = value;
		this.#settings = settings;
	}

	static async open(options: Options): Promise<Channel> {
		const log = scoped(options.log, { channel: options.id });
		let channel: Channel;
		const registry = createRegistry();
		registry.install(logging(log));
		registry.install(CodingTools);
		const handoffs = new Handoffs(options.directory);
		registry.install(handoffs.extension);
		const questions = new Questions((chat) => void channel.#asked(chat));
		registry.install(questions.extension);
		const execute = options.desktop;
		if (execute) {
			registry.install(desktop(async (request, context) => {
				// Check every dispatch, including child chats and calls from already-active runs.
				if (!channel.#settings.desktop) {
					return {
						text:
							"Native desktop tools are off for this channel, and no desktop operation was dispatched. If the task needs them, ask the channel owner to turn on Channel desktop tools in the channel header, then wait for their reply instead of working around it.",
						isError: true,
						outcome: "refused",
					};
				}
				return execute(request, context);
			}));
		}
		if (options.browser) registry.install(browser(options.browser));
		if (options.images) registry.install(images(options.images));
		if (options.tabs) registry.install(tabs(options.tabs));
		registry.install(lanes({ ...options, name: options.prefix || options.name }));
		registry.install(subagent(questions.extension));
		registry.install(metadata((value) => channel.#changed(value), options.claim));
		registry.install(messaging(options.directory));
		registry.install(
			defineExtension({ name: "ace-channel", sections: [room.section(options), instructions] }),
		);
		const harness = await Harness.open(options.storage, {
			models: options.models,
			registry,
			env: ({ cwd }) => options.env(cwd || options.project),
			onReport: (error) => log("error", "harness.report", failure(error)),
		}, context);
		// Only a new channel stores its settings at creation; an existing one without them is legacy.
		if (!await harness.conversation(ROOT_CONVERSATION_ID, context)) {
			await harness.commit(async (tx) => void await tx.doc(SettingsDoc), context);
		}
		const { lane } = options;
		await harness.root(context, {
			agent: { model: options.model, cwd: lane?.path || options.project },
			...(lane
				? {
					init: async (tx, chat) => {
						(await tx.doc(LanesDoc)).lanes[lane.name] = { chat, path: lane.path, base: lane.base };
					},
				}
				: {}),
		});
		const value = await harness.commit(async (tx) => {
			const doc = await tx.doc(MetadataDoc);
			// A missing document is the version 0 upgrade; existing pi metadata always wins.
			if (!doc.name) {
				doc.name = options.name;
				doc.named = options.named ?? true;
			}
			return { name: doc.name, summary: doc.summary, revision: doc.revision };
		}, context);
		const settings = await harness.snapshot(SettingsDoc, context);
		channel = new Channel(
			options,
			harness,
			log,
			value,
			settings || LEGACY,
		);
		channel.#changed(value);
		// Scheduling has not resumed and no caller has this channel yet, so the initial snapshot
		// and subscription cannot miss a run transition. LiveDoc forks start empty in pi.
		await channel.#snapshotBusy();
		channel.#unsubscribe = harness.subscribeCommits(({ changes }) => {
			const ended: [ConversationId, readonly SubmissionId[]][] = [];
			for (const change of changes) {
				if (change.type === "entry" && change.value.model?.[0]?.role === "assistant") {
					channel.#caption(change.value.conversationId);
				}
				if (change.type === "entry") channel.#said(change.value);
				if (change.type !== "document") continue;
				// Commit order, not request completion order, decides the state clients see.
				if (change.record.kind === SettingsDoc.definition.kind) {
					channel.#settings = change.value as Settings;
					channel.#broadcast();
					continue;
				}
				if (change.record.kind === MessagesDoc.definition.kind) {
					const { scope } = change.record;
					const value = change.value as Messages | null;
					if (scope.kind === "conversation" && value) {
						const chat = scope.conversationId;
						channel.#sendActions(chat, { kind: "reactions", chat, reactions: value.reactions });
					}
					continue;
				}
				if (change.record.kind === InboxDoc.definition.kind) {
					const { scope } = change.record;
					if (scope.kind === "conversation") {
						handoffs.inbox(scope.conversationId, change.value as InboxState | null);
						questions.inbox(scope.conversationId, change.value as InboxState | null);
					}
					continue;
				}
				if (change.record.kind !== LiveDoc.definition.kind) continue;
				const { scope } = change.record;
				if (scope.kind !== "conversation") continue;
				const { run } = (change.value || {}) as LiveState;
				const inputs = channel.#runs.get(scope.conversationId);
				if (run) channel.#runs.set(scope.conversationId, run.inputs);
				else if (inputs) {
					channel.#runs.delete(scope.conversationId);
					channel.#caption(scope.conversationId);
					ended.push([scope.conversationId, inputs]);
				}
			}
			// Ending a run settles its inputs in the same commit, in no particular change order.
			for (const [chat, inputs] of ended) void channel.#ended(chat, inputs, changes);
			// Publish once per atomic commit, not once per chat or streaming delta.
			channel.#publishBusy();
			if (changes.some((change) => change.type === "entry")) channel.#activity();
		});
		// Opening resumes work a crash interrupted; a killed channel left only terminal tasks behind.
		harness.resume();
		log("info", "channel.open", { name: value.name, project: options.project });
		return channel;
	}

	/** Runs a client request, logging its outcome with the caller's `trace` id. */
	async handle(request: Request, send: Send, trace?: string): Promise<unknown> {
		const start = Date.now();
		const fields = {
			...(trace ? { trace } : {}),
			op: request.op,
			...("chat" in request && request.chat !== undefined ? { chat: request.chat } : {}),
			...("author" in request ? { author: request.author } : {}),
			...("requestId" in request && request.requestId ? { requestId: request.requestId } : {}),
			...("model" in request && request.model ? { model: request.model } : {}),
		};
		try {
			const value = await this.#handle(request, send);
			// Watches and polls are constant traffic; their failures still log below.
			const level = request.op === "watch" || request.op === "info" || request.op === "models"
				? "debug"
				: "info";
			this.#log(level, "request", { ...fields, ms: Date.now() - start, ...result(value) });
			return value;
		} catch (error) {
			// Refused requests are expected; their message is enough.
			const message = error instanceof Error ? error.message : String(error);
			this.#log("warn", "request.failed", { ...fields, ms: Date.now() - start, error: message });
			throw error;
		}
	}

	async #handle(request: Request, send: Send): Promise<unknown> {
		switch (request.op) {
			case "info":
				return this.info();
			case "models":
				return available(this.#options.models);
			case "say":
				return this.#say(request);
			case "ask":
				return this.#ask(request);
			case "chat":
				return this.#chat(request);
			case "answer": {
				this.#author(request.author);
				await this.#mayInvoke(request.author);
				const { id } = await this.#conversation(request.chat);
				const answers = "text" in request ? request.text : request.answers;
				return answer(this.#harness, id, request.call, request.author, answers, context);
			}
			case "skip": {
				this.#author(request.author);
				await this.#mayInvoke(request.author);
				const { id } = await this.#conversation(request.chat);
				return answer(this.#harness, id, request.call, request.author, null, context);
			}
			case "react": {
				this.#author(request.author);
				const { id } = await this.#conversation(request.chat);
				const entry = request.entry as EntryId;
				const reaction = { from: request.author, emoji: request.emoji };
				return react(this.#harness, id, entry, reaction, !!request.remove, context);
			}
			case "delete": {
				this.#author(request.author);
				const { id } = await this.#conversation(request.chat);
				return remove(this.#harness, id, request.entry as EntryId, request.author, context);
			}
			case "edit": {
				this.#author(request.author);
				const { id } = await this.#conversation(request.chat);
				const entry = request.entry as EntryId;
				return edit(this.#harness, id, entry, request.author, request.text, context);
			}
			case "stop": {
				this.#author(request.author);
				// Whoever can't start a run here can't end the owner's either.
				await this.#mayInvoke(request.author);
				return (await this.#conversation(request.chat)).abort(context);
			}
			case "kill":
				this.#author(request.author);
				await this.#mayInvoke(request.author);
				return this.kill();
			case "share":
				return this.#share(request);
			case "desktop":
				return this.#desktop(request);
			case "rename":
				return this.#rename(request);
			case "watch":
				return this.#watch(request, send);
			case "changes": {
				const { cwd, lane } = await this.#place(request.chat);
				return changes(this.#options.env(cwd), cwd, this.#options.project, lane, context);
			}
			case "fetch": {
				const { cwd, lane } = await this.#place(request.chat);
				return fetchBase(this.#options.env(cwd), cwd, lane?.base, context);
			}
			case "patch": {
				const { cwd, lane } = await this.#place(request.chat);
				const { env, project } = this.#options;
				return patch(env(cwd), cwd, project, lane?.base, request.file, request.state, context);
			}
			case "wait": {
				const submission = await this.#harness.submission(
					request.submission as SubmissionId,
					context,
				);
				if (!submission) throw new Error(`Unknown submission ${request.submission}`);
				return (await submission.wait(context)).status;
			}
		}
	}

	async info(): Promise<ChannelInfo> {
		const { id, project, owner } = this.#options;
		const { name, summary, revision } = (await this.#harness.snapshot(MetadataDoc, context))!;
		const records: ConversationRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await this.#harness.commit(
				(tx) => tx.scanConversations({}, 256, cursor),
				context,
			);
			records.push(...page.items);
			cursor = page.next;
		} while (cursor);
		const lanes = (await this.#harness.snapshot(LanesDoc, context))?.lanes || {};
		const byPath = new Map(Object.entries(lanes).map(([lane, { path }]) => [path, lane]));
		const chats: Chat[] = await Promise.all(records.map(async (record) => {
			const [agent, live, spent] = await Promise.all([
				this.#harness.snapshot(AgentDoc, record.id, context),
				this.#harness.snapshot(LiveDoc, record.id, context),
				this.#harness.snapshot(UsageDoc, record.id, context),
			]);
			const cwd = agent?.cwd;
			const lane = cwd && byPath.get(cwd);
			const chat: Chat = { id: record.id, busy: !!live?.run, usage: usage(spent) };
			const window = agent?.model
				&& this.#options.models.getModel(agent.model.provider, agent.model.modelId)?.contextWindow;
			const used = window && await this.#used(record.id);
			if (window && used) chat.context = { used, window };
			if (record.owner) chat.parent = record.owner.conversationId;
			if (agent?.model) chat.model = agent.model;
			chat.effort = agent?.thinkingLevel || "off";
			if (lane) Object.assign(chat, { lane, cwd });
			return chat;
		}));
		return { id, name, summary, revision, project, owner, ...this.#settings, chats };
	}

	/** The newest response's own token count; providers report what that request carried. */
	async #used(id: ConversationId): Promise<number | undefined> {
		const conversation = await this.#harness.conversation(id, context);
		const { messages } = await conversation!.context(context);
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.role !== "assistant") continue;
			const { input, output, cacheRead, cacheWrite } = message.usage;
			const total = input + output + cacheRead + cacheWrite;
			// A failed or aborted request reports nothing; the context is what the last real one carried.
			if (total) return total;
		}
	}

	get busy(): boolean {
		return this.#runs.size > 0;
	}

	async isIdle(): Promise<boolean> {
		return !this.busy;
	}

	async #snapshotBusy(): Promise<void> {
		let cursor: Cursor | undefined;
		do {
			const page = await this.#harness.commit(
				(tx) => tx.scanConversations({}, 256, cursor),
				context,
			);
			for (const { id } of page.items) {
				const live = await this.#harness.snapshot(LiveDoc, id, context);
				if (live?.run) this.#runs.set(id, live.run.inputs);
			}
			cursor = page.next;
		} while (cursor);
		this.#publishBusy();
	}

	#publishBusy(): void {
		const busy = this.busy;
		if (busy === this.#publishedBusy) return;
		try {
			this.#options.onBusy?.(busy);
			this.#publishedBusy = busy;
		} catch (error) {
			this.#log("warn", "busy.publish", failure(error));
		}
	}

	async #ended(
		chat: ConversationId,
		inputs: readonly SubmissionId[],
		changes: readonly CommitChange[],
	): Promise<void> {
		const settled = new Map<SubmissionId, SubmissionRecord>();
		for (const change of changes) {
			if (change.type === "submission") settled.set(change.value.id, change.value);
		}
		const last = settled.get(inputs.at(-1)!);
		if (!last) return;
		const outcome = last.status === "done"
			? "done"
			: last.reason === "aborted"
			? "stopped"
			: "failed";
		await this.#publishRun(chat, inputs.map((id) => settled.get(id)?.entry), outcome);
	}

	/** A run waiting on a question needs the same attention as one that ended. */
	async #asked(chat: ConversationId): Promise<void> {
		const inputs = this.#runs.get(chat);
		if (!inputs) return;
		const entries = await Promise.all(inputs.map(async (id) => {
			const submission = await this.#harness.submission(id, context);
			return (await submission?.status(context))?.entry;
		}));
		await this.#publishRun(chat, entries, "question");
	}

	async #publishRun(
		chat: ConversationId,
		entries: (SubmissionRecord["entry"])[],
		outcome: RunEnd["outcome"],
	): Promise<void> {
		try {
			// The newest human input names who is waiting; agents' inputs are their parents' work.
			const author = await this.#harness.commit(async (tx) => {
				for (const entry of entries.toReversed()) {
					const human = entry === undefined ? undefined : room.human((await tx.entry(entry))!);
					if (human && !room.isAgent(human.author)) return human.author;
				}
			}, context);
			if (author) this.#options.onRun?.({ chat, at: Date.now(), outcome, author });
		} catch (error) {
			this.#log("warn", "run.publish", failure(error));
		}
	}

	/** Durably abort every chat's work, including background subagents, so reopening resumes none of it. */
	/** The channel's chats as a seed another channel can import. */
	export(): Promise<Seed> {
		return exportSeed(this.#harness);
	}

	/** Fills a new channel from a seed, `shift` milliseconds later than its own times. */
	import(value: Seed, shift?: number): Promise<void> {
		return importSeed(this.#harness, value, shift);
	}

	async kill(): Promise<void> {
		const { chats } = await this.info();
		this.#log("warn", "channel.kill", {
			chats: chats.filter((chat) => chat.busy).map((c) => c.id),
		});
		await Promise.all(chats.map(async (chat) => {
			const conversation = await this.#harness.conversation(chat.id as ConversationId, context);
			await conversation?.abort(context, { background: true });
		}));
	}

	async close(): Promise<void> {
		this.#log("info", "channel.close");
		this.#unsubscribe?.();
		this.#closing.abort();
		try {
			await this.#harness.close(context);
		} finally {
			this.#runs.clear();
			this.#publishBusy();
		}
	}

	/** Where a chat works: its current lane's worktree, or the project checkout before it has one. */
	async #place(
		chat: ChatId | undefined,
	): Promise<{ cwd: string; lane?: { name: string; base?: string } }> {
		const { id } = await this.#conversation(chat);
		const cwd = (await this.#harness.snapshot(AgentDoc, id, context))?.cwd || this.#options.project;
		const lanes = (await this.#harness.snapshot(LanesDoc, context))?.lanes || {};
		const found = Object.entries(lanes).find(([, value]) => value.path === cwd);
		if (!found) return { cwd };
		const [name, { base }] = found;
		return { cwd, lane: base ? { name, base } : { name } };
	}

	async #conversation(chat: ChatId | undefined): Promise<Conversation> {
		const conversation = await this.#harness.conversation(
			(chat ?? ROOT_CONVERSATION_ID) as ConversationId,
			context,
		);
		if (!conversation) throw new Error(`No chat ${chat}`);
		return conversation;
	}

	#author(author: string) {
		if (!room.isAuthor(author)) throw new Error(`Invalid author ${author}`);
	}

	async #say(request: Extract<Request, { op: "say" }>) {
		this.#author(request.author);
		const conversation = await this.#conversation(request.chat);
		room.checkAttachments(request);
		// The chat's next run reads this message, so it must fit the model the chat has now.
		const { model } = await conversation.agent(context);
		const selected = model && this.#options.models.getModel(model.provider, model.modelId);
		if (selected) room.checkContext(selected, request);
		const entry = room.draft(request.author, request.text, Date.now(), request);
		const submission = await conversation.submit({
			type: "write",
			entry,
			...(request.requestId ? { requestId: request.requestId } : {}),
		}, context);
		return { submission: submission.id };
	}

	async #ask(request: Extract<Request, { op: "ask" }>) {
		const chat = request.chat || ROOT_CONVERSATION_ID;
		const previous = this.#admissions.get(chat) || Promise.resolve();
		// Selection and submission must stay together across concurrent clients.
		const pending = previous.catch(() => {}).then(() => this.#admit(request));
		this.#admissions.set(chat, pending);
		try {
			return await pending;
		} finally {
			if (this.#admissions.get(chat) === pending) this.#admissions.delete(chat);
		}
	}

	async #admit(request: Extract<Request, { op: "ask" }>) {
		this.#author(request.author);
		room.checkAttachments(request);
		await this.#mayInvoke(request.author);
		const conversation = await this.#conversation(request.chat);
		await this.#select(conversation, request, request.model, request.effort, request.automatic);
		const submission = await conversation.submit({
			type: "input",
			content: room.content(request.author, request.text, request),
			whenBusy: "steer",
			...(request.requestId ? { requestId: request.requestId } : {}),
		}, context);
		return { submission: submission.id };
	}

	async #mayInvoke(author: string) {
		const settings = await this.#harness.snapshot(SettingsDoc, context);
		// Hosts rewrite every client's author, so an agent author is another channel's agent on this
		// host, already running as the owner's user. Sharing gates teammates, not those handoffs.
		if (author === this.#options.owner || room.isAgent(author) || settings?.shared !== false) {
			return;
		}
		throw new Error("Only the owner can invoke agents here");
	}

	/** Model and effort apply to a whole run, never just its later turns. */
	async #select(
		conversation: Conversation,
		attached: room.Attached,
		requested: ModelRef | undefined,
		effort?: Effort,
		automatic?: boolean,
	) {
		const agent = await conversation.agent(context);
		const current = agent.model;
		// A chat's inherited model can lose its provider key; only an explicit request must keep it.
		const kept = !requested && !automatic && current && await usable(this.#options.models, current)
			? current
			: undefined;
		const model = requested || kept || await (
			this.#options.defaultModel?.() || choose(this.#options.models)
		);
		const selected = this.#options.models.getModel(model.provider, model.modelId);
		if (!selected) {
			throw new Error(`Unknown model ${model.provider}/${model.modelId}`);
		}
		// Before configuring, so a refused message leaves the chat's model as it was.
		room.checkContext(selected, attached);
		const levels = getSupportedThinkingLevels(selected);
		if (effort !== undefined && effort !== "off" && !levels.includes(effort)) {
			throw new Error(
				`Unsupported reasoning effort ${effort} for ${model.provider}/${model.modelId}`,
			);
		}
		// Pi's "off" means omit reasoning, allowing provider defaults on always-thinking models.
		const thinkingLevel = effort
			|| (levels.includes(agent.thinkingLevel) ? agent.thinkingLevel : "off");
		const sameModel = current?.provider === model.provider && current.modelId === model.modelId;
		const same = sameModel && thinkingLevel === agent.thinkingLevel;
		const live = await this.#harness.snapshot(LiveDoc, conversation.id, context);
		if (!same && live?.run) {
			throw new Error(
				"The chat is busy; stop it or wait before changing its model or reasoning effort",
			);
		}
		if (model !== kept && !await usable(this.#options.models, model)) {
			// getModel above found this model, so its provider is registered.
			const name = this.#options.models.getProvider(model.provider)!.name;
			throw new Error(
				`The ${name} API key is missing. Add it in Provider settings to invoke an agent. Chat is still available.`,
			);
		}
		if (same) return;
		await conversation.configure({ model, thinkingLevel }, context);
	}

	async #chat(request: Extract<Request, { op: "chat" }>) {
		this.#author(request.author);
		const conversation = await this.#harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: request.model || this.#options.model, cwd: this.#options.project },
		}, context);
		return { chat: conversation.id };
	}

	async #share(request: Extract<Request, { op: "share" }>) {
		if (request.author !== this.#options.owner) {
			throw new Error("Only the owner can change sharing");
		}
		await this.#harness.commit(async (tx) => {
			(await tx.doc(SettingsDoc)).shared = request.shared;
		}, context);
	}

	async #desktop(request: Extract<Request, { op: "desktop" }>) {
		if (request.author !== this.#options.owner) {
			throw new Error("Only the owner can change desktop tools access");
		}
		if (typeof request.enabled !== "boolean") throw new Error("enabled must be a boolean");
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(SettingsDoc);
			// A legacy channel's first write would otherwise store `initial`'s unshared default.
			doc.shared = this.#settings.shared;
			doc.desktop = request.enabled;
		}, context);
	}

	async #rename(request: Extract<Request, { op: "rename" }>): Promise<Metadata> {
		if (request.author !== this.#options.owner) {
			throw new Error("Only the owner can rename the channel");
		}
		const name = validateName(request.name);
		const value = await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(MetadataDoc);
			if (doc.name !== name) {
				doc.name = await this.#options.claim?.(name, true) || name;
				doc.revision++;
			}
			doc.named = true;
			return { name: doc.name, summary: doc.summary, revision: doc.revision };
		}, context);
		this.#changed(value);
		return value;
	}

	#changed(value: Metadata): void {
		if (value.revision < this.#metadata.revision) return;
		this.#metadata = value;
		try {
			this.#options.onMetadata?.(value);
		} catch (error) {
			this.#log("warn", "metadata.publish", failure(error));
		}
		this.#broadcast();
	}

	/** Every metadata event carries the whole current state, so the newest one a client saw wins. */
	#broadcast(): void {
		for (const listener of this.#listeners) {
			try {
				listener.send(this.#event(listener.chat));
			} catch {
				this.#listeners.delete(listener);
			}
		}
	}

	#event(chat: ChatId): Event {
		return { kind: "metadata", chat, ...this.#metadata, ...this.#settings };
	}

	#said(entry: EntryRecord): void {
		const human = room.human(entry);
		if (!human) return;
		const names = [...human.text.matchAll(MENTION)].map((match) => match[1]!.toLowerCase());
		const mentions = [...new Set(names)];
		try {
			this.#options.onSaid?.({
				chat: entry.conversationId,
				at: human.at,
				author: human.author,
				...(mentions.length ? { mentions } : {}),
			});
		} catch (error) {
			this.#log("warn", "said.publish", failure(error));
		}
	}

	#activity(): void {
		const now = Date.now();
		if (now - this.#active < ACTIVITY_INTERVAL) return;
		this.#active = now;
		try {
			this.#options.onActivity?.(now);
		} catch (error) {
			this.#log("warn", "activity.publish", failure(error));
		}
	}

	/** Coalesces requests so each chat has at most one captioning pass running. */
	#caption(id: ConversationId): void {
		if (this.#captioning.has(id)) return void this.#captioning.set(id, true);
		this.#captioning.set(id, false);
		void (async () => {
			do {
				this.#captioning.set(id, false);
				await this.#captionPass(id).catch((error) => {
					if (!this.#closing.signal.aborted) this.#log("warn", "caption", failure(error));
				});
			} while (this.#captioning.get(id) && !this.#closing.signal.aborted);
			this.#captioning.delete(id);
		})();
	}

	async #captionPass(id: ConversationId): Promise<void> {
		const conversation = await this.#harness.conversation(id, context);
		if (!conversation) return;
		const [agent, live, view, stored] = await Promise.all([
			this.#harness.snapshot(AgentDoc, id, context),
			this.#harness.snapshot(LiveDoc, id, context),
			conversation.context(context),
			this.#harness.snapshot(CaptionsDoc, id, context),
		]);
		const captions = { ...stored?.groups };
		const recaps = { ...stored?.recaps };
		const { models } = this.#options;
		const signal = this.#closing.signal;
		let fast: Model<any> | undefined | null;
		let strong: Model<any> | undefined | null;
		for (const segment of segments(view.messages, !!live?.run)) {
			for (const [index, group] of segment.groups.entries()) {
				const key = group.calls[0]!.id;
				if (!isStale(group, captions[key])) continue;
				fast ??= await pick(models, FAST, agent?.model) || null;
				if (!fast) return;
				const previous = segment.groups.slice(Math.max(0, index - 3), index)
					.flatMap((earlier) => captions[earlier.calls[0]!.id]?.text || []);
				const { text, usage } = await caption(
					models,
					fast,
					segment.request,
					group,
					previous,
					signal,
				);
				const value = { calls: group.calls.map((call) => call.id), text, done: group.closed };
				await this.#harness.commit(async (tx) => {
					(await tx.doc(CaptionsDoc, id)).groups[key] = value;
					spend(await tx.doc(UsageDoc, id), usage);
				}, context);
				captions[key] = value;
				this.#sendCaption(id, { kind: "caption", chat: id, calls: value.calls, text });
			}
			if (!segment.closed || !segment.groups.length) continue;
			const calls = segment.groups.flatMap((group) => group.calls.map((call) => call.id));
			const key = calls[0]!;
			if (recaps[key]?.calls.length === calls.length) continue;
			strong ??= await pick(models, STRONG, agent?.model)
				|| await pick(models, FAST, agent?.model) || null;
			if (!strong) return;
			const { text, usage } = await recap(models, strong, segment, captions, signal);
			await this.#harness.commit(async (tx) => {
				(await tx.doc(CaptionsDoc, id)).recaps[key] = { calls, text };
				spend(await tx.doc(UsageDoc, id), usage);
			}, context);
			recaps[key] = { calls, text };
			this.#sendCaption(id, { kind: "recap", chat: id, calls, text });
		}
	}

	#sendCaption(chat: ConversationId, event: Event): void {
		for (const listener of this.#listeners) {
			if (listener.chat !== chat || !listener.captions) continue;
			try {
				listener.send(event);
			} catch {
				this.#listeners.delete(listener);
			}
		}
	}

	#sendActions(chat: ConversationId, event: Event): void {
		for (const listener of this.#listeners) {
			if (listener.chat !== chat || !listener.actions) continue;
			try {
				listener.reacted = true;
				listener.send(event);
			} catch {
				this.#listeners.delete(listener);
			}
		}
	}

	/** Replays the chat's active transcript, then streams. Resolves when the stream ends. */
	async #watch(request: Extract<Request, { op: "watch" }>, send: Send) {
		const conversation = await this.#conversation(request.chat);
		const stream = await watchEvents(this.#harness, conversation.id, context);
		const tools = request.progress ? progress(conversation.id, send) : undefined;
		// Agent events expose only inbox IDs. The shared conversation mount carries their content,
		// including an atomic initial snapshot and updates when the inbox is first created.
		const view = request.queue
			? await conversation.watch(context).catch(async (error) => {
				await stream.stop();
				throw error;
			})
			: undefined;
		const actions = !!request.actions;
		const listener: Listener = {
			chat: conversation.id,
			send,
			captions: !!request.captions,
			actions,
		};
		this.#listeners.add(listener);
		// Read after the stream's snapshot, so every deletion it holds is here; later ones arrive live.
		const messages = await this.#harness.snapshot(MessagesDoc, conversation.id, context);
		const deleted = messages?.deleted || {};
		// Clients that did not opt in never see deletions or edits as events, but replay still drops
		// a deleted message's content and shows an edited one's newest text.
		const forward = (event: Event) => {
			if ((event.kind === "deleted" || event.kind === "edited") && !actions) return;
			if (event.kind !== "message" || !deleted[event.entry]) return send(event);
			const { images: _, files: __, edited: ___, ...rest } = event;
			send({ ...rest, text: "", deleted: true });
		};
		// An edit follows its message, so replay folds the newest one in and sends no earlier text.
		const edits = new Map<number, { text: string; at: number }>();
		for (const entry of stream.snapshot.entries) {
			if (EditEntry.is(entry)) edits.set(entry.data.target, entry.data);
		}
		const replay = (event: Event) => {
			if (event.kind === "edited") return;
			if (event.kind !== "message") return forward(event);
			const edited = edits.get(event.entry);
			forward(edited ? { ...event, text: edited.text, edited: edited.at } : event);
		};
		void stream.closed.then(() => {
			this.#listeners.delete(listener);
			tools?.stop();
			return view?.stop();
		});
		void view?.closed.then(() => stream.stop());
		send(this.#event(conversation.id));
		for (const entry of stream.snapshot.entries) for (const event of events(entry)) replay(event);
		// A commit while the document was read has already sent its newer state.
		if (actions && !listener.reacted && Object.keys(messages?.reactions || {}).length) {
			send({ kind: "reactions", chat: conversation.id, reactions: messages!.reactions });
		}
		if (request.captions) {
			const captions = await this.#harness.snapshot(CaptionsDoc, conversation.id, context);
			for (const { calls, text } of Object.values(captions?.groups || {})) {
				send({ kind: "caption", chat: conversation.id, calls, text });
			}
			for (const { calls, text } of Object.values(captions?.recaps || {})) {
				send({ kind: "recap", chat: conversation.id, calls, text });
			}
		}
		if (stream.snapshot.run) send({ kind: "run", chat: conversation.id, state: "start" });
		tools?.snapshot(stream.snapshot.tools);
		if (view) {
			let messages = queue(view.value);
			send({ kind: "queue", chat: conversation.id, messages });
			let inbox = view.value.docs[InboxDoc.definition.kind];
			view.start(async (value) => {
				const next = value.docs[InboxDoc.definition.kind];
				if (next === inbox) return;
				inbox = next;
				const before = messages;
				messages = queue(value);
				const gone = await withdrawn(this.#harness, before, messages);
				send({
					kind: "queue",
					chat: conversation.id,
					messages,
					...(gone.length ? { withdrawn: gone } : {}),
				});
			});
		}
		send({ kind: "live", chat: conversation.id });
		stream.start(async (batch) => {
			for (const event of batch) {
				if (event.type === "snapshot") tools?.snapshot(event.tools);
				else tools?.update(event);
				for (const mapped of live(conversation.id, event)) forward(mapped);
			}
		});
		return {
			stop: async () => {
				this.#listeners.delete(listener);
				tools?.stop();
				await view?.stop();
				return stream.stop();
			},
		};
	}
}

function usage(state: Readonly<UsageState> | undefined): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	if (!state) return total;
	for (const bucket of [state.models, state.tools]) {
		for (const value of Object.values(bucket)) {
			total.input += value.input;
			total.output += value.output;
			total.cacheRead += value.cacheRead;
			total.cacheWrite += value.cacheWrite;
			total.totalTokens += value.totalTokens;
			total.cost += value.cost.total;
		}
	}
	return total;
}

/** Submission and chat ids a request produced, so later lines can be traced back to it. */
function result(value: unknown) {
	if (!value || typeof value !== "object") {
		return typeof value === "string"
			? { result: value }
			: {};
	}
	const { submission, chat } = value as { submission?: number; chat?: number };
	return { ...(submission ? { submission } : {}), ...(chat ? { created: chat } : {}) };
}

/** Providers append their JSON error body; its message is the part a person can act on. */
function readable(error: string | undefined): string {
	if (!error) return "The provider failed the response";
	const start = error.indexOf("{");
	if (start < 0) return error;
	try {
		const body = JSON.parse(error.slice(start));
		const detail = body.message ?? body.error?.message;
		return typeof detail === "string" ? `${error.slice(0, start).trim()} ${detail}` : error;
	} catch {
		return error;
	}
}

/**
 * The transcript keeps whatever overflowed, so every later run in the chat fails the same way until
 * a person removes it; channels from before attachments were checked against the model can hold one.
 */
function failed(message: AssistantMessage): string {
	const error = readable(message.errorMessage);
	if (!isContextOverflow(message)) return error;
	const hint = "This chat no longer fits the model's context, so every run fails this way until "
		+ "you delete the message with the large attachment or pick a model with a larger context.";
	return `${error.replace(/\.?$/, ".")} ${hint}`;
}

function live(chat: ChatId, event: AgentEvent): Event[] {
	if (event.type === "message_end" || event.type === "entry_appended") return events(event.entry);
	if (event.type === "message_update") {
		const text = event.changes.flatMap((change) =>
			change.type === "text_delta" ? [change.delta] : []
		).join("");
		return text ? [{ kind: "delta", chat, text }] : [];
	}
	if (event.type === "run_start") return [{ kind: "run", chat, state: "start" }];
	if (event.type === "run_end") return [{ kind: "run", chat, state: "end" }];
	return [];
}

function events(entry: EntryRecord): Event[] {
	const chat = entry.conversationId;
	if (DeletionEntry.is(entry)) return [{ kind: "deleted", chat, entry: entry.data.target }];
	if (EditEntry.is(entry)) {
		const { target, text, at } = entry.data;
		return [{ kind: "edited", chat, entry: target, text, at }];
	}
	const human = room.human(entry);
	if (human) return [{ kind: "message", chat, entry: entry.id, ...human }];
	const message = entry.model?.[0];
	if (message?.role === "assistant") {
		const out: Event[] = [];
		const text = room.text(message);
		const at = message.timestamp;
		const model = message.model;
		const error = message.stopReason === "error";
		const stopped = message.stopReason === "aborted";
		if (text || error || stopped) {
			out.push({
				kind: "reply",
				chat,
				entry: entry.id,
				at,
				model,
				text,
				...(error ? { error: failed(message) } : {}),
				...(stopped ? { stopped } : {}),
			});
		}
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			out.push({
				kind: "tool",
				chat,
				at,
				model,
				call: block.id,
				name: block.name,
				args: block.arguments,
			});
		}
		return out;
	}
	if (message?.role === "toolResult") {
		const codes = ToolResultEntry.is(entry) ? entry.data.diagnostics.map(({ code }) => code) : [];
		const stopped = codes.includes("aborted");
		// pi reports this only when recovery finds an unsafe call that a previous worker started.
		const interrupted = codes.includes("interrupted");
		const handoff = codes.includes(HANDOFF);
		const images = room.images(message);
		return [{
			kind: "result",
			chat,
			call: message.toolCallId,
			error: message.isError,
			text: room.text(message),
			...(images ? { images } : {}),
			...(stopped ? { stopped: true } : {}),
			...(interrupted ? { interrupted: true } : {}),
			...(handoff ? { handoff: true } : {}),
		}];
	}
	return [];
}
