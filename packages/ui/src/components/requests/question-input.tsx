import type { ComponentPropsWithRef } from "react";

import { cn } from "../../lib/utils";

type Props = Omit<ComponentPropsWithRef<"textarea">, "onChange" | "value" | "name"> & {
	label: string;
	name: string;
	active: boolean;
	value: string;
	onActive: () => void;
	onChange: (value: string) => void;
};

/** Controlled custom answer with the same input layout as the shared legacy questionnaire. */
export function QuestionInput({
	label,
	name,
	active,
	value,
	disabled,
	className,
	onActive,
	onChange,
	...props
}: Props) {
	return (
		<div className="relative mt-1.5">
			<label
				onPointerDown={event => event.currentTarget.querySelector("input")?.focus()}
				className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted/60 has-disabled:cursor-not-allowed"
			>
				<input
					type="radio"
					name={name}
					checked={active}
					disabled={disabled}
					onChange={onActive}
					className="mt-1 size-3.5 shrink-0 accent-primary"
				/>
				<span className="font-medium">Write a custom answer</span>
			</label>
			<div className="relative mt-1.5">
				<textarea
					rows={2}
					maxLength={4000}
					aria-label={`Custom answer for ${label}`}
					placeholder="Type another answer"
					{...props}
					disabled={disabled}
					value={value}
					onFocus={onActive}
					onChange={event => onChange(event.currentTarget.value)}
					className={cn(
						"min-h-16 w-full resize-y rounded-md border border-input bg-input/20 px-2.5 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60",
						className,
					)}
				/>
			</div>
		</div>
	);
}
