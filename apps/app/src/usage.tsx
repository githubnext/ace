import {
	Button,
	Popover,
	PopoverPopup,
	PopoverPortal,
	PopoverPositioner,
	PopoverTrigger,
} from "@ace/ui";
import type { Usage as Totals } from "@ace/channel/protocol";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});

function cost(value: number): string {
	return value > 0 && value < 0.0001 ? "<$0.0001" : dollars.format(value);
}

/** A ring for how full the context window is, like other coding agents show. */
function Ring({ fraction }: { fraction: number }) {
	const radius = 6;
	const length = 2 * Math.PI * radius;
	return (
		<svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
			<circle
				cx="8"
				cy="8"
				r={radius}
				fill="none"
				strokeWidth="2"
				className="stroke-foreground/20"
			/>
			<circle
				cx="8"
				cy="8"
				r={radius}
				fill="none"
				strokeWidth="2"
				strokeLinecap="round"
				strokeDasharray={length}
				strokeDashoffset={length * (1 - Math.min(fraction, 1))}
				className={fraction > 0.9
					? "stroke-destructive"
					: fraction > 0.7
					? "stroke-amber-500"
					: "stroke-muted-foreground"}
			/>
		</svg>
	);
}

export function Usage({ value, context }: {
	value: Totals;
	context?: { used: number; window: number };
}) {
	const fraction = context ? context.used / context.window : 0;
	const percent = Math.round(fraction * 100);
	const rows = [
		["Input", value.input],
		["Output", value.output],
		["Cache read", value.cacheRead],
		["Cache write", value.cacheWrite],
	] as const;
	return (
		<Popover>
			<PopoverTrigger
				aria-label={context ? `Context ${percent}% full` : "Chat usage"}
				render={<Button variant="ghost" size="icon-sm" className="size-6 text-muted-foreground" />}
			>
				<Ring fraction={fraction} />
			</PopoverTrigger>
			<PopoverPortal>
				<PopoverPositioner side="top" align="end" sideOffset={8}>
					<PopoverPopup className="w-64 p-4 text-xs" aria-label="Chat usage">
						<h3 className="mb-1 text-sm font-medium">Context</h3>
						<p className="mb-3 tabular-nums text-muted-foreground">
							{context
								? `${percent}% · ${compact.format(context.used)} of ${
									compact.format(context.window)
								} tokens`
								: "No responses yet"}
						</p>
						<h3 className="mb-2 text-sm font-medium">Billed in this chat</h3>
						<dl className="space-y-2">
							{rows.map(([label, count]) => (
								<div key={label} className="flex justify-between gap-4">
									<dt className="text-muted-foreground">{label}</dt>
									<dd className="tabular-nums">{exact.format(count)}</dd>
								</div>
							))}
							<div className="flex justify-between gap-4 border-t pt-2">
								<dt className="text-muted-foreground">Estimated cost (USD)</dt>
								<dd className="tabular-nums">{cost(value.cost)}</dd>
							</div>
						</dl>
						<p className="mt-3 leading-relaxed text-muted-foreground">
							Token counts are what each provider reported. Every request re-sends the conversation,
							mostly as cache reads, so billed tokens grow faster than the context. Cost uses list
							prices.
						</p>
					</PopoverPopup>
				</PopoverPositioner>
			</PopoverPortal>
		</Popover>
	);
}
