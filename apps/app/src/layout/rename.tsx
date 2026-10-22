import { type FormEvent, useEffect, useRef, useState } from "react";

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ace/ui";

type Props = {
	open: boolean;
	name: string;
	title?: string;
	label?: string;
	description?: string;
	maxLength?: number;
	pattern?: string;
	required?: boolean;
	onSave: (name: string) => void | Promise<void>;
	onCancel: () => void;
};

export function Rename(
	{
		open,
		name,
		title = "Rename tab",
		label = "Tab name",
		description,
		maxLength = 80,
		pattern,
		required,
		onSave,
		onCancel,
	}: Props,
) {
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => {
			const node = input.current;
			if (!node) return;
			node.value = name;
			node.focus();
			node.select();
		});
		return () => cancelAnimationFrame(frame);
	}, [open, name]);

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await onSave(input.current?.value ?? name);
		} catch (error) {
			setError((error as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={next => (next || busy ? undefined : onCancel())}>
			<DialogContent className="gap-3 sm:max-w-80" showCloseButton={false}>
				<form className="flex flex-col gap-3" onSubmit={save}>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription className={description ? undefined : "sr-only"}>
							{description || "Set a custom tab name."}
						</DialogDescription>
					</DialogHeader>
					<input
						ref={input}
						defaultValue={name}
						aria-label={label}
						maxLength={maxLength}
						pattern={pattern}
						required={required}
						disabled={busy}
						aria-invalid={!!error}
						// The browser blocks a malformed submit before save() could clear a refusal.
						onChange={() => setError("")}
						autoCorrect="off"
						autoCapitalize="off"
						spellCheck={false}
						className="h-8 w-full min-w-0 rounded-md squircle border border-input bg-input/20 px-2 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 md:text-xs/relaxed dark:bg-input/30"
					/>
					{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
							Cancel
						</Button>
						<Button type="submit" disabled={busy}>{busy ? "Renaming…" : "Rename"}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
