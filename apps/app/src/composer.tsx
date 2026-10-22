import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
	aceAvatar,
	type Attachment,
	Button,
	ChatComposer,
	type ChatComposerHandle,
	serialize,
	toast,
	useLocalStorage,
	useMedia,
} from "@ace/ui";
import {
	type Effort,
	MAX_IMAGES,
	type ModelOption,
	type ModelRef,
	type QueuedMessage,
} from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import { host } from "./host";
import { attachments } from "./attachments";

const ACE_MODE = { id: "ace", name: "Ace", placeholder: "Ask the agent", mention: "ace" };
const MODES = [
	{ id: "chat", name: "Chat", placeholder: "Mention @ace to ask the agent" },
	ACE_MODE,
];
// A teammate the owner hasn't let invoke sees no @ace; the stored mode brings it back with access.
const BLOCKED_MODES = [{
	id: "chat",
	name: "Chat",
	placeholder: "Message the channel (agent access is off)",
}];
const ACE_MENTION = { name: "ace", avatar: aceAvatar };
export const EFFORTS: Record<Effort, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};
const ACE = /(^|\s)@ace\b/i;
const LEADING = /^\s*@ace\b/i;
const UNPICKED: { model?: string; effort?: Effort } = {};

const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;
// Errors a provider gives for the model or its key, which another try with them would repeat.
const MODEL_FAULT =
	/\b(401|403|404)\b|api key|unauthori[sz]ed|authenticat|permission|does not exist|not found|access to/i;
const RETRY = "Try again.";

type Props = {
	channel: Listing;
	chat: number;
	user: string;
	current?: ModelRef;
	currentEffort?: Effort;
	busy: boolean;
	/** What a pending send waits on, as its submit control's label. */
	waiting: string;
	/** Whether teammates may invoke agents; absent while unknown. */
	shared?: boolean;
	ready: boolean;
	draft?: string;
	onDraftLoaded: () => void;
	/** Messages withdrawn from the chat's queue; the user's own come back into the draft. */
	returned: QueuedMessage[];
	/** The error of the chat's latest run, when it failed and nothing has run since. */
	failure?: string;
	onProviders?: () => void;
	accessory?: ReactNode;
	/** People to suggest after @, by GitHub login. */
	members: { name: string; avatar?: string }[];
};

/** Below the composer: its attachment tray rises over the space above it and takes clicks there. */
export function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div
			className="mt-2 flex items-center justify-between gap-3 px-3 text-xs text-muted-foreground"
			role="status"
		>
			<p>{children}</p>
			{action}
		</div>
	);
}

/** A failed admission keeps the draft and attachments available for retry. */
export function Composer(
	{
		channel,
		chat: id,
		user,
		current,
		currentEffort,
		busy,
		waiting,
		shared,
		ready,
		draft,
		onDraftLoaded,
		returned,
		failure,
		onProviders,
		accessory,
		members,
	}: Props,
) {
	const composer = useRef<ChatComposerHandle>(null);
	const sending = useRef(false);
	const typed = useRef(0);
	const [pending, setPending] = useState(false);
	const [attached, setAttached] = useState<Attachment[]>([]);
	// Kept beside the channel's draft so a deliberate mode and an unsent model pick survive relaunch.
	const scope = `/channels/${channel.id}`;
	const [stored, changeMode] = useLocalStorage(`ace:mode:${scope}`, "ace");
	// The channel refuses a blocked teammate's ask, stop, and kill too.
	const blocked = shared === false && channel.owner !== user;
	const mode = blocked ? "chat" : stored;
	const mentions = useMemo(() => blocked ? members : [ACE_MENTION, ...members], [blocked, members]);
	const [models, setModels] = useState<ModelOption[]>();
	const [modelError, setModelError] = useState<string>();
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const settingsVersion = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	useEffect(() => {
		if (!draft) return;
		composer.current?.set(ACE.test(draft) ? draft : `@ace ${draft}`);
		onDraftLoaded();
	}, [draft, onDraftLoaded]);
	// A saved Ace draft keeps its words as a message; its mention returns with access, from the mode.
	useEffect(() => {
		if (!blocked) return;
		const doc = composer.current?.get();
		const text = doc ? serialize(doc) : "";
		if (ACE.test(text)) composer.current?.set(text.replace(/(^|\s)@ace\b\s*/gi, "$1").trim());
	}, [blocked]);
	// Each withdrawn message returns once, ahead of whatever the user has typed since.
	const restored = useRef(new Set<number>());
	useEffect(() => {
		const mine = returned.filter((message) =>
			message.author === user && !restored.current.has(message.submission)
		);
		if (!mine.length) return;
		for (const message of mine) restored.current.add(message.submission);
		const doc = composer.current?.get();
		// One leading mention invokes the whole draft; an empty Ace-mode composer holds only that.
		const text = [...mine.map((message) => message.text), doc ? serialize(doc) : ""]
			.map((part) => part.replace(LEADING, "").trim()).filter(Boolean).join("\n\n");
		composer.current?.set(blocked ? text : `@ace ${text}`);
		const images = mine.flatMap((message) => message.images || []);
		const files = mine.flatMap((message) => message.files || []);
		if (images.length || files.length) {
			setAttached((current) => [
				...current,
				...images.map((image, index) => ({
					id: crypto.randomUUID(),
					name: `Image ${index + 1}`,
					type: image.mimeType,
					preview: `data:${image.mimeType};base64,${image.data}`,
				})),
				...files.map(({ name, text }) => {
					const file = new File([text], name, { type: "text/plain" });
					return { id: crypto.randomUUID(), name, type: file.type, size: file.size, file };
				}),
			]);
		}
		toast(
			mine.length === 1
				? "Stopped before your queued message ran"
				: `Stopped before ${mine.length} of your queued messages ran`,
			{ description: `${mine.length === 1 ? "It's" : "They're"} back in the composer.` },
		);
	}, [returned, user, blocked]);
	// An offline channel can't answer; the conversation already says so, so don't blame providers.
	const offline = channel.state === "offline";
	useEffect(() => {
		// A chat that can't load can't answer either; asking again once it loads is how a refused
		// channel's models recover, such as after a cloud workspace starts or Try again.
		if (status !== "open" || mode !== "ace" || offline || !ready) return;
		let active = true;
		// Ask the channel itself: a hosted channel uses the service's credentials, not its workspace's.
		host.channel<ModelOption[]>(channel.id, { op: "models" }).then(
			(models) => {
				if (!active) return;
				setModels(models);
				setModelError(undefined);
			},
			(error: Error) => {
				if (!active) return;
				setModels([]);
				setModelError(error.message);
			},
		);
		return () => {
			active = false;
		};
	}, [channel.id, mode, status, settingsVersion, offline, ready]);
	const [{ model: picked, effort: pickedEffort }, changePick] = useLocalStorage(
		`ace:pick:${scope}/${id}`,
		UNPICKED,
	);
	const model = picked || (current ? key(current) : "auto");
	const levels = models?.find((value) => key(value) === model)?.efforts;
	const requestedEffort = pickedEffort
		|| (current && key(current) === model ? currentEffort : undefined) || "off";
	const effort = requestedEffort === "off" || levels?.includes(requestedEffort)
		? requestedEffort
		: "off";
	const efforts = levels && levels.some((level) => level !== "off")
		? (levels.includes("off") ? levels : ["off" as const, ...levels]).map((id) => ({
			id,
			name: id === "off" && !levels.includes("off") ? "Default" : EFFORTS[id],
		}))
		: undefined;
	const choices = (models || []).map((value) => ({
		id: key(value),
		name: value.modelId,
		vendor: value.provider,
	}));
	if (model !== "auto" && !choices.some((value) => value.id === model)) {
		choices.unshift({ id: model, name: model.split("/").slice(1).join("/"), vendor: "" });
	}
	// Automatic stays offered so a chat whose model lost its key can hand the choice back.
	choices.unshift({ id: "auto", name: "Automatic", vendor: "" });
	// Formatting tools crowd a phone's composer; they stay one tap away.
	const phone = useMedia("(width < 40rem)");

	function attach(next: Attachment[]) {
		let images = 0;
		const kept = next.filter((item) => !item.type.startsWith("image/") || ++images <= MAX_IMAGES);
		if (kept.length < next.length) {
			const left = next.length - kept.length;
			toast(`A message can carry ${MAX_IMAGES} images`, {
				description: left === 1 ? "One image wasn't attached." : `${left} images weren't attached.`,
			});
		}
		setAttached(kept);
	}

	async function send(text: string, mode: string, attached: Attachment[]) {
		if (sending.current) return;
		// Posted, a blocked teammate's "@ace" would read as an ask nobody answers.
		if (blocked && ACE.test(text)) {
			toast.error("Agent access is off", {
				description:
					"The owner hasn't let teammates ask this channel's agent. Remove @ace to send this as a message.",
			});
			return;
		}
		const invoke = !blocked && (mode === "ace" || ACE.test(text));
		const body = text.trim();
		if (!body && !attached.length) return;
		// The channel would refuse it for want of a key; setup keeps the draft for sending after.
		if (mode === "ace" && models?.length === 0 && !modelError && onProviders) {
			return onProviders();
		}
		const doc = composer.current?.get();
		sending.current = true;
		setPending(true);
		try {
			const encoded = await attachments(attached);
			if (invoke) {
				const [provider, ...rest] = model.split("/");
				await host.channel(channel.id, {
					op: "ask",
					...(levels ? { effort } : {}),
					chat: id,
					author: user,
					text: body,
					...encoded,
					// An unpicked model lets the channel replace a chat model whose provider lost its key.
					...(picked && picked !== "auto"
						? { model: { provider: provider!, modelId: rest.join("/") } }
						: {}),
				});
			} else {
				await host.channel(channel.id, {
					op: "say",
					chat: id,
					author: user,
					text: body,
					...encoded,
				});
			}
			if (composer.current?.get() === doc) composer.current?.clear();
			const sent = new Set(attached);
			setAttached((current) => current.filter((value) => !sent.has(value)));
		} catch (error) {
			const { message } = error as Error;
			// Only a missing key is fixed in Providers; busy, access and size errors are not.
			const keys = invoke && onProviders && /provider key/i.test(message);
			toast.error(invoke ? "Could not invoke agent" : "Could not send message", {
				description: message,
				...(keys ? { action: { label: "Providers", onClick: onProviders } } : {}),
			});
		} finally {
			sending.current = false;
			setPending(false);
		}
	}

	// Retrying a model's own failure on that model would fail again, so it hands the choice back.
	const reset = !!failure && MODEL_FAULT.test(failure) && model !== "auto";
	async function retry() {
		if (sending.current) return;
		sending.current = true;
		setPending(true);
		try {
			const [provider, ...rest] = model.split("/");
			await host.channel(channel.id, {
				op: "ask",
				chat: id,
				author: user,
				text: RETRY,
				...(reset
					? { automatic: true }
					: {
						...(levels ? { effort } : {}),
						...(picked && picked !== "auto"
							? { model: { provider: provider!, modelId: rest.join("/") } }
							: {}),
					}),
			});
			if (reset) {
				changePick(UNPICKED);
				toast("Switched this chat to Automatic", {
					description: `${model} failed, so Retry let Ace choose the model.`,
				});
			}
		} catch (error) {
			toast.error("Could not retry", { description: (error as Error).message });
		} finally {
			sending.current = false;
			setPending(false);
		}
	}

	return (
		<>
			<ChatComposer
				ref={composer}
				accessory={accessory}
				scope={scope}
				tools={!phone}
				mic
				modes={blocked ? BLOCKED_MODES : MODES}
				mode={mode}
				onModeChange={changeMode}
				mentions={mentions}
				models={choices}
				model={model}
				onModelChange={(value) => changePick({ model: value })}
				efforts={efforts}
				effort={effort}
				onEffortChange={(value) => changePick({ model: picked, effort: value as Effort })}
				attachments={attached}
				onAttachmentsChange={attach}
				busy={busy}
				submitBusy={pending}
				submitLabel={waiting}
				onTypingChange={(value) => {
					// Watchers drop a typist after 5 s without a signal, so one every 3 s keeps them shown.
					if (!value || !ready || Date.now() - typed.current < 3000) return;
					typed.current = Date.now();
					host.channel(channel.id, { op: "typing", chat: id, author: user }).catch(() => {});
				}}
				canStop={busy && !blocked}
				onStop={() => void host.channel(channel.id, { op: "stop", chat: id, author: user })}
				canSend={ready && status === "open" && !pending}
				clearOnSend={false}
				onSend={({ doc, mode, attachments }) => void send(serialize(doc), mode, attachments)}
			/>
			{failure && !blocked && !busy && (
				<Notice
					action={
						<Button
							size="sm"
							variant="outline"
							disabled={!ready || status !== "open" || pending}
							onClick={() => void retry()}
						>
							Retry
						</Button>
					}
				>
					{reset
						? `The last run failed on ${model}. Retry switches this chat to Automatic.`
						: "The last run failed."}
				</Notice>
			)}
			{mode === "ace" && !offline && models?.length === 0 && (
				<Notice
					action={onProviders && (
						<Button size="sm" variant="outline" onClick={onProviders}>
							{modelError ? "Provider settings" : "Set up a provider"}
						</Button>
					)}
				>
					{modelError || "Add a provider to use Ace. You can still send messages in Chat mode."}
				</Notice>
			)}
		</>
	);
}
