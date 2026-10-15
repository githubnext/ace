import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

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
import type { Effort, ModelOption, ModelRef } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import { host } from "./host";
import { images } from "./images";

const ACE_MODE = { id: "ace", name: "Ace", placeholder: "Ask the agent", mention: "ace" };
const MODES = [
	{ id: "chat", name: "Chat", placeholder: "Mention @ace to ask the agent" },
	ACE_MODE,
];
// Teammates keep the Ace mode and their drafts while the owner has turned invocation off.
const BLOCKED_MODES = [{ id: "chat", name: "Chat", placeholder: "Message the channel" }, ACE_MODE];
const MENTIONS = [{ name: "ace", avatar: aceAvatar }];
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
const UNPICKED: { model?: string; effort?: Effort } = {};

const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

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
	onSettings?: () => void;
	accessory?: ReactNode;
};

/** The channel refuses these too; holding them here keeps the draft instead of failing a send. */
function useInvocation(shared: boolean | undefined, owner: boolean, mode: string) {
	const [mentioned, setMentioned] = useState(false);
	const blocked = shared === false && !owner;
	return {
		blocked,
		refused: blocked && (mode === "ace" || mentioned),
		onText: (text: string) => setMentioned(ACE.test(text)),
	};
}

/** Below the composer: its attachment tray rises over the space above it and takes clicks there. */
function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
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

/** Why a teammate's invoking draft is held while the owner has turned invocation off. */
function Refusal({ mode, onChat }: { mode: string; onChat: () => void }) {
	return (
		<Notice
			action={
				<Button size="sm" variant="ghost" onClick={onChat}>
					{mode === "ace" ? "Switch to Chat" : "Remove @ace"}
				</Button>
			}
		>
			The owner has turned off teammate agent invocation.{" "}
			{mode === "ace" ? "Switch to Chat" : "Remove @ace"} to send this as a message.
		</Notice>
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
		onSettings,
		accessory,
	}: Props,
) {
	const composer = useRef<ChatComposerHandle>(null);
	const sending = useRef(false);
	const [pending, setPending] = useState(false);
	const [attached, setAttached] = useState<Attachment[]>([]);
	// Kept beside the channel's draft so a deliberate mode and an unsent model pick survive relaunch.
	const scope = `/channels/${channel.id}`;
	const [mode, changeMode] = useLocalStorage(`ace:mode:${scope}`, "ace");
	const [models, setModels] = useState<ModelOption[]>();
	const [modelError, setModelError] = useState<string>();
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const settingsVersion = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	useEffect(() => {
		if (!draft) return;
		composer.current?.set(ACE.test(draft) ? draft : `@ace ${draft}`);
		onDraftLoaded();
	}, [draft, onDraftLoaded]);
	// An offline channel can't answer; the conversation already says so, so don't blame providers.
	const offline = channel.state === "offline";
	useEffect(() => {
		if (status !== "open" || mode !== "ace" || offline) return;
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
	}, [channel.id, mode, status, settingsVersion, offline]);
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
	const { blocked, refused, onText } = useInvocation(shared, channel.owner === user, mode);
	// A mention invokes in Chat mode too, so sending as a message drops it from the draft.
	const toChat = () => {
		changeMode("chat");
		const doc = composer.current?.get();
		const text = doc ? serialize(doc) : "";
		if (ACE.test(text)) composer.current?.set(text.replace(/(^|\s)@ace\b\s*/gi, "$1").trim());
	};
	// Formatting tools crowd a phone's composer; they stay one tap away.
	const phone = useMedia("(width < 40rem)");

	async function send(text: string, mode: string, attached: Attachment[]) {
		if (sending.current) return;
		const invoke = mode === "ace" || ACE.test(text);
		const body = text.trim();
		if (!body && !attached.length) return;
		if (invoke && blocked) {
			return void toast.error("Could not invoke agent", {
				description: "The owner has turned off teammate agent invocation.",
			});
		}
		const doc = composer.current?.get();
		sending.current = true;
		setPending(true);
		try {
			const encoded = attached.length ? { images: await images(attached) } : {};
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
			toast.error(invoke ? "Could not invoke agent" : "Could not send message", {
				description: (error as Error).message,
				...(invoke && onSettings ? { action: { label: "Settings", onClick: onSettings } } : {}),
			});
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
				modes={blocked ? BLOCKED_MODES : MODES}
				mode={mode}
				onModeChange={changeMode}
				onTextChange={onText}
				mentions={MENTIONS}
				models={choices}
				model={model}
				onModelChange={(value) => changePick({ model: value })}
				efforts={efforts}
				effort={effort}
				onEffortChange={(value) => changePick({ model: picked, effort: value as Effort })}
				attachments={attached}
				onAttachmentsChange={setAttached}
				busy={busy}
				submitBusy={pending}
				submitLabel={waiting}
				canStop={busy}
				onStop={() => void host.channel(channel.id, { op: "stop", chat: id })}
				canSend={ready && status === "open" && !pending && !refused}
				clearOnSend={false}
				onSend={({ doc, mode, attachments }) => void send(serialize(doc), mode, attachments)}
			/>
			{refused
				? <Refusal mode={mode} onChat={toChat} />
				: mode === "ace" && !offline && models?.length === 0 && (
					<Notice
						action={onSettings && (
							<Button size="sm" variant="ghost" onClick={onSettings}>Provider settings</Button>
						)}
					>
						{modelError || "Add a provider to use Ace. You can still send messages in Chat mode."}
					</Notice>
				)}
		</>
	);
}
