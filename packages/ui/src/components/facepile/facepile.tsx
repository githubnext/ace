import { type ComponentPropsWithRef, type ReactNode, useId } from "react";

import { cn } from "../../lib/utils";

type Avatar = {
	/** Image URL. */
	src: string;
	/** Accessible label (usually the user's name or handle). */
	alt?: string;
	/** Desaturated and faded, as for someone who is away. */
	dimmed?: boolean;
};

type Props = Omit<ComponentPropsWithRef<"div">, "children"> & {
	/** Avatars to render, in display order. */
	avatars: Avatar[];
	/** Maximum number of avatars to show before collapsing into an overflow indicator. Default `3`. */
	max?: number;
	/** Pixel size of each avatar. Default `20`. */
	size?: number;
	/** Pixel gap cut between neighbors by the SVG mask. Default `2`. */
	gap?: number;
	/** Transparent inset around each avatar, letting the parent background show through. Default `1`. */
	gutter?: number;
	/** Overlap ratio from `0` (flush) to `1` (fully overlapping). Default `0.35`. */
	overlap?: number;
	/** Custom renderer for the overflow indicator; receives the number of hidden avatars. */
	more?: (remaining: number) => ReactNode;
};

/** Stacked avatar group with SVG-mask cutouts between neighbors, collapsing to a `+N` indicator past `max`. */
function Facepile({
	avatars,
	max = 3,
	size = 20,
	gap = 2,
	gutter = 1,
	overlap = 0.35,
	more,
	className,
	style,
	ref,
	...rest
}: Props) {
	let id = useId();
	let visible = avatars.slice(0, max);
	let remaining = Math.max(0, avatars.length - max);
	let overflow = remaining > 0;
	let offset = -((size + gap) * overlap);
	let center = size * 0.5;
	let radius = center;
	let inner = Math.max(0, radius - gutter);

	return (
		<div ref={ref} className={cn("flex", className)} style={style} {...rest}>
			{visible.map((avatar, i) => {
				let cut = i < (overflow ? visible.length : visible.length - 1);
				let mask = `facepile-${id}-${i}`;
				return (
					<svg
						key={avatar.alt || avatar.src}
						role="none"
						width={size}
						height={size}
						className={cn(
							"block shrink-0 contain-strict",
							avatar.dimmed && "opacity-45 grayscale",
						)}
						style={{ marginInlineStart: i === 0 ? 0 : offset }}
					>
						<mask id={mask}>
							<circle cx={center} cy={center} r={inner} fill="white" />
							{cut && (
								<circle
									cx={size - (size + gap) * overlap + center}
									cy={center}
									r={radius + gap * 0.5}
									fill="black"
								/>
							)}
						</mask>
						<g mask={`url(#${mask})`}>
							<circle
								cx={center}
								cy={center}
								r={radius}
								style={{ fill: "var(--muted)" }}
							/>
							<image
								aria-label={avatar.alt}
								x="0"
								y="0"
								width="100%"
								height="100%"
								preserveAspectRatio="xMidYMid slice"
								href={avatar.src}
							/>
						</g>
					</svg>
				);
			})}
			{overflow && (
				<div
					className="shrink-0"
					style={{ marginInlineStart: visible.length === 0 ? 0 : offset }}
				>
					{more
						? more(remaining)
						: (
							<div
								className="flex items-center justify-center rounded-full border border-border bg-muted text-muted-foreground font-medium contain-strict"
								style={{
									inlineSize: size,
									blockSize: size,
									fontSize: Math.round(size * 0.4),
								}}
							>
								+{remaining}
							</div>
						)}
				</div>
			)}
		</div>
	);
}

export { Facepile };
export type { Avatar as FacepileAvatar, Props as FacepileProps };
