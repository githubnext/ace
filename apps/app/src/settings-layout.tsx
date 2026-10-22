import { type ComponentProps, type ReactNode, useState } from "react";

import { Button, Input } from "@ace/ui";

export function Page({ children }: { children: ReactNode }) {
	return <div className="flex flex-col gap-8">{children}</div>;
}

/** A titled list of rows separated by hairlines, with an optional control beside the title. */
export function Group({ title, action, children }: {
	title?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col" aria-label={title}>
			{(title || action) && (
				<div className="flex min-h-7 items-center justify-between gap-2 pb-1">
					{title && <h3 className="text-sm font-medium text-foreground">{title}</h3>}
					{action && <div className="ml-auto">{action}</div>}
				</div>
			)}
			<div className="flex flex-col divide-y divide-border/60">{children}</div>
		</section>
	);
}

/** Label and at most one line of description on the left, controls on the right. */
export function Row({ label, description, children, footer, id }: {
	label: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	/** Full-width content under the row: inline forms, confirmations, and action results. */
	footer?: ReactNode;
	id?: string;
}) {
	return (
		<div className="flex flex-col gap-2 py-3">
			<div className="flex flex-col gap-2 @md:flex-row @md:items-center @md:justify-between @md:gap-6">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div id={id} className="text-sm text-foreground">{label}</div>
					{description && (
						<div className="text-xs/relaxed break-words text-pretty text-muted-foreground">
							{description}
						</div>
					)}
				</div>
				{children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
			</div>
			{footer}
		</div>
	);
}

/** A read-only value in a row's control slot. */
export function Value({ children }: { children: ReactNode }) {
	return <span role="status" className="text-xs text-muted-foreground">{children}</span>;
}

/** A text setting saved explicitly; Save appears once the draft differs from the saved value. */
export function TextRow({ label, description, saved, onSave, footer, disabled, ...props }:
	& Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onSubmit">
	& {
		label: string;
		description?: ReactNode;
		saved?: string;
		onSave: (value: string) => Promise<void>;
		footer?: ReactNode;
	})
{
	const [draft, setDraft] = useState<string>();
	const [action, setAction] = useState<{ busy?: boolean; error?: string }>({});
	const value = draft ?? (saved || "");
	const dirty = draft !== undefined && draft.trim() !== (saved || "");
	const locked = saved === undefined || disabled || action.busy;

	async function save() {
		setAction({ busy: true });
		try {
			await onSave(value.trim());
			setDraft(undefined);
			setAction({});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	return (
		<Row
			label={label}
			description={description}
			footer={(footer || action.error) && (
				<>
					{footer}
					{action.error && <Problem>{action.error}</Problem>}
				</>
			)}
		>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<Input
					spellCheck={false}
					aria-label={label}
					className="h-7 w-64 text-xs"
					value={value}
					disabled={locked}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Escape" || draft === undefined) return;
						// Escape discards the draft before it reaches the dialog.
						event.stopPropagation();
						setDraft(undefined);
					}}
					{...props}
				/>
				{dirty && <Button type="submit" disabled={locked}>Save</Button>}
			</form>
		</Row>
	);
}

export function Segmented<T extends string>({ value, options, onChange, ...props }: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
	"aria-labelledby": string;
}) {
	return (
		<div role="radiogroup" className="inline-flex h-7 rounded-md bg-muted p-0.5" {...props}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={option.value === value}
					onClick={() => onChange(option.value)}
					className="rounded-[5px] px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-xs motion-reduce:transition-none"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

export function Select({ className, ...props }: ComponentProps<"select">) {
	return (
		<select
			className={`h-7 max-w-full min-w-28 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 ${
				className || ""
			}`}
			{...props}
		/>
	);
}

/** An inline confirmation for a destructive action, shown in a row's footer. */
export function Confirm({ children, action, busy, onConfirm, onCancel }: {
	children: ReactNode;
	action: string;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-xs @md:flex-row @md:items-center @md:justify-between">
			<p>{children}</p>
			<div className="flex shrink-0 gap-2">
				<Button variant="destructive" disabled={busy} onClick={onConfirm}>{action}</Button>
				<Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
			</div>
		</div>
	);
}

/** A time today, or a date and time when older, so a stale sync doesn't read as recent. */
export function when(time: number) {
	const date = new Date(time);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString()
		: date.toLocaleString();
}

export function Status({ children }: { children: ReactNode }) {
	return <p role="status" className="text-xs/relaxed text-muted-foreground">{children}</p>;
}

export function Problem({ children }: { children: ReactNode }) {
	return <p role="alert" className="text-xs/relaxed break-words text-destructive">{children}</p>;
}
