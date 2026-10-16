import type { QueuedMessage } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import { authorName } from "./timeline";

/** Authors are named as the timeline names them. */
export function MessageQueue({ messages, people, channels }: {
	messages: QueuedMessage[];
	people: Record<string, string>;
	channels: Map<string, Listing>;
}) {
	if (!messages.length) return null;
	return (
		<section
			aria-label="Queued messages"
			className="mb-2 overflow-hidden rounded-lg border border-border/60 bg-muted/40 text-xs"
		>
			<div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-muted-foreground">
				<p role="status">
					{messages.length} queued {messages.length === 1 ? "message" : "messages"}
				</p>
				<span>Waiting for the agent</span>
			</div>
			<ol className="max-h-48 overflow-y-auto overscroll-contain divide-y divide-border/60">
				{messages.map((message) => (
					<li key={message.submission} className="px-3 py-2">
						<div className="mb-1 flex min-w-0 items-center gap-2 text-muted-foreground">
							<span className="truncate font-medium">
								{authorName(message.author, people, channels)}
							</span>
							<span className="shrink-0">{message.invoked ? "@ace" : "Chat"}</span>
						</div>
						{message.text && (
							<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
								{message.text}
							</p>
						)}
						{message.images && (
							<div className="mt-2 flex flex-wrap gap-2">
								{message.images.map((image, index) => (
									<img
										key={index}
										src={`data:${image.mimeType};base64,${image.data}`}
										alt={`Queued attachment ${index + 1}`}
										className="size-12 rounded-md object-cover"
									/>
								))}
							</div>
						)}
						{message.files && (
							<p className="mt-1 truncate text-muted-foreground">
								{message.files.map((file) => file.name).join(", ")}
							</p>
						)}
					</li>
				))}
			</ol>
		</section>
	);
}
