import { getSupportedThinkingLevels, type Model, type Models } from "@earendil-works/pi-ai";
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
	type EntryRecord,
	Harness,
	InboxDoc,
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

import { type Directory, messaging, Subagent } from "./agents";
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
import { changes, patch } from "./changes";
import { type Desktop, desktop } from "./desktop";
import { lanes, LanesDoc } from "./lanes";
import { failure, type Log, logging, scoped } from "./log";
import { metadata, MetadataDoc, validateName } from "./metadata";
import { available, choose, usable } from "./models";
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
	Usage,
} from "./protocol";
import { queue } from "./queue";
import * as room from "./room";

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
	/** The host's current preference, consulted only for a chat's first agent invocation. */
	defaultModel?(): Promise<ModelRef>;
	storage: Storage;
	models: Models;
	env(cwd: string): ExecutionEnv;
	desktop?: Desktop;
	browser?: Browser;
	directory: Directory;
	/** Publish a projection of committed metadata to the runtime's channel catalog. */
	onMetadata?(value: Metadata): void;
	/** Publish when the transcript last grew, in epoch milliseconds. */
	onActivity?(at: number): void;
	/** Rebuildable channel-wide projection of pi live runs, including child chats. */
	onBusy?(busy: boolean): void;
	/** Publish each run a person invoked as it ends, for their attention. */
	onRun?(run: RunEnd): void;
	log: Log;
};

type Send = (event: Event) => void;

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
	#listeners = new Set<{ chat: ChatId; send: Send; captions: boolean }>();
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
		registry.install(lanes({ ...options, name: options.prefix || options.name }));
		registry.install(Subagent);
		registry.install(metadata((value) => channel.#changed(value)));
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
		await harness.root(context, { agent: { model: options.model, cwd: options.project } });
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
				if (change.type !== "document") continue;
				// Commit order, not request completion order, decides the state clients see.
				if (change.record.kind === SettingsDoc.definition.kind) {
					channel.#settings = change.value as Settings;
					channel.#broadcast();
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
			case "stop":
				return (await this.#conversation(request.chat)).abort(context);
			case "kill":
				return this.kill();
			case "share":
				return this.#share(request);
			case "desktop":
				return this.#desktop(request);
			case "rename":
				return this.#rename(request);
			case "watch":
				return this.#watch(request.chat, send, request.queue, request.captions);
			case "changes": {
				const { cwd, lane } = await this.#place(request.chat);
				return changes(this.#options.env(cwd), cwd, this.#options.project, lane, context);
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
		try {
			// The newest human input names who is waiting; agents' inputs are their parents' work.
			const author = await this.#harness.commit(async (tx) => {
				for (const id of inputs.toReversed()) {
					const entry = settled.get(id)?.entry;
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
		room.checkImages(request.images);
		const entry = room.draft(request.author, request.text, Date.now(), request.images);
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
		room.checkImages(request.images);
		const settings = await this.#harness.snapshot(SettingsDoc, context);
		const isOwner = request.author === this.#options.owner;
		// Hosts rewrite every client's author, so an agent author is another channel's agent on this
		// host, already running as the owner's user. Sharing gates teammates, not those handoffs.
		if (!isOwner && !room.isAgent(request.author) && settings?.shared === false) {
			throw new Error("Only the owner can invoke agents here");
		}
		const conversation = await this.#conversation(request.chat);
		await this.#select(conversation, request.model, request.effort);
		const submission = await conversation.submit({
			type: "input",
			content: room.content(request.author, request.text, request.images),
			whenBusy: "steer",
			...(request.requestId ? { requestId: request.requestId } : {}),
		}, context);
		return { submission: submission.id };
	}

	/** Model and effort apply to a whole run, never just its later turns. */
	async #select(conversation: Conversation, requested: ModelRef | undefined, effort?: Effort) {
		const agent = await conversation.agent(context);
		const current = agent.model;
		// A chat's inherited model can lose its provider key; only an explicit request must keep it.
		const kept = !requested && current && await usable(this.#options.models, current)
			? current
			: undefined;
		const model = requested || kept || await (
			this.#options.defaultModel?.() || choose(this.#options.models)
		);
		const selected = this.#options.models.getModel(model.provider, model.modelId);
		if (!selected) {
			throw new Error(`Unknown model ${model.provider}/${model.modelId}`);
		}
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
			if (doc.name !== name) doc.revision++;
			doc.name = name;
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

	/** Replays the chat's active transcript, then streams. Resolves when the stream ends. */
	async #watch(
		chat: ChatId | undefined,
		send: Send,
		includeQueue = false,
		includeCaptions = false,
	) {
		const conversation = await this.#conversation(chat);
		const stream = await watchEvents(this.#harness, conversation.id, context);
		// Agent events expose only inbox IDs. The shared conversation mount carries their content,
		// including an atomic initial snapshot and updates when the inbox is first created.
		const view = includeQueue
			? await conversation.watch(context).catch(async (error) => {
				await stream.stop();
				throw error;
			})
			: undefined;
		const listener = { chat: conversation.id, send, captions: includeCaptions };
		this.#listeners.add(listener);
		void stream.closed.then(() => {
			this.#listeners.delete(listener);
			return view?.stop();
		});
		void view?.closed.then(() => stream.stop());
		send(this.#event(conversation.id));
		for (const entry of stream.snapshot.entries) for (const event of events(entry)) send(event);
		if (includeCaptions) {
			const captions = await this.#harness.snapshot(CaptionsDoc, conversation.id, context);
			for (const { calls, text } of Object.values(captions?.groups || {})) {
				send({ kind: "caption", chat: conversation.id, calls, text });
			}
			for (const { calls, text } of Object.values(captions?.recaps || {})) {
				send({ kind: "recap", chat: conversation.id, calls, text });
			}
		}
		if (stream.snapshot.run) send({ kind: "run", chat: conversation.id, state: "start" });
		if (view) {
			send({ kind: "queue", chat: conversation.id, messages: queue(view.value) });
			let inbox = view.value.docs[InboxDoc.definition.kind];
			view.start(async (value) => {
				const next = value.docs[InboxDoc.definition.kind];
				if (next === inbox) return;
				inbox = next;
				send({ kind: "queue", chat: conversation.id, messages: queue(value) });
			});
		}
		send({ kind: "live", chat: conversation.id });
		stream.start(async (batch) => {
			for (const event of batch) for (const mapped of live(conversation.id, event)) send(mapped);
		});
		return {
			stop: async () => {
				this.#listeners.delete(listener);
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

function live(chat: ChatId, event: AgentEvent): Event[] {
	if (event.type === "message_end") return events(event.entry);
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
				...(error ? { error: readable(message.errorMessage) } : {}),
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
		const stopped = ToolResultEntry.is(entry)
			&& entry.data.diagnostics.some(({ code }) => code === "aborted");
		const images = room.images(message);
		return [{
			kind: "result",
			chat,
			call: message.toolCallId,
			error: message.isError,
			text: room.text(message),
			...(images ? { images } : {}),
			...(stopped ? { stopped: true } : {}),
		}];
	}
	return [];
}
