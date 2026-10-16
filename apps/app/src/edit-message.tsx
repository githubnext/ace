import { useEffect, useRef, useState } from "react";

import { ChatComposer, type ChatComposerHandle, serialize, toast, useMedia } from "@ace/ui";

import { host } from "./host";

type Props = {
	channel: string;
	chat: number;
	user: string;
	entry: number;
	text: string;
	onDone: () => void;
};

/**
 * The composer in edit mode, holding one of the user's messages. It closes once the channel stores
 * the edit, so a refused edit keeps the new text for another try; Escape or its X cancels.
 */
export function EditMessage({ channel, chat, user, entry, text, onDone }: Props) {
	const composer = useRef<ChatComposerHandle>(null);
	const [pending, setPending] = useState(false);
	useEffect(() => composer.current?.set(text), [text]);
	const phone = useMedia("(width < 40rem)");
	const save = (next: string) => {
		const body = next.trim();
		if (body === text.trim()) return onDone();
		setPending(true);
		host.channel(channel, { op: "edit", chat, author: user, entry, text: body }).then(
			() => {
				composer.current?.clear();
				onDone();
			},
			(error: Error) => {
				setPending(false);
				toast.error("Could not edit the message", { description: error.message });
			},
		);
	};
	return (
		<ChatComposer
			ref={composer}
			scope={`/channels/${channel}/${chat}/edit`}
			tools={!phone}
			placeholder="Edit your message"
			editing
			submitBusy={pending}
			submitLabel="Saving"
			canSend={!pending}
			clearOnSend={false}
			onCancelEdit={onDone}
			onSend={({ doc }) => save(serialize(doc))}
		/>
	);
}
