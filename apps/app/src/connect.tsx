import { useState } from "react";

import { Button, Input, ThemeProvider } from "@ace/ui";
import { IconGlobe } from "@ace/ui/icons";

import { normalize, remember } from "./address";

/** The deployed web app has no host of its own; the person names theirs once. */
export function Connect({ previous }: { previous?: string }) {
	const [value, setValue] = useState(previous ?? "");
	const target = normalize(value);

	return (
		<ThemeProvider storageKey="ace-theme">
			<main className="flex min-h-dvh items-center justify-center bg-background px-5 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
				<form
					className="flex w-full max-w-sm flex-col gap-5"
					onSubmit={(event) => {
						event.preventDefault();
						if (!target) return;
						remember(target);
						location.reload();
					}}
				>
					<div className="grid size-10 place-items-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
						<IconGlobe className="size-5" aria-hidden />
					</div>
					<div className="flex flex-col gap-2">
						<h1 className="text-xl font-medium">Connect to your host</h1>
						<p className="text-sm leading-6 text-muted-foreground">
							{previous
								? `Couldn't reach ${previous}. Check that Tailscale is on, then try again or enter another host.`
								: "Enter the address your Ace host prints for HTTPS, such as mac.tailnet.ts.net:5140. This device must be on your tailnet."}
						</p>
					</div>
					<Input
						aria-label="Host address"
						placeholder="mac.tailnet.ts.net:5140"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						inputMode="url"
						enterKeyHint="go"
						className="h-11 text-base"
						value={value}
						onChange={(event) => setValue(event.target.value)}
					/>
					<Button type="submit" size="lg" className="h-11" disabled={!target}>
						{previous && target === previous ? "Try again" : "Connect"}
					</Button>
				</form>
			</main>
		</ThemeProvider>
	);
}
