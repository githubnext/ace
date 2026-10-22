/** Design lane only: the screenshot harness picks unbuilt onboarding states with `__ACE_DESIGN__`. */
const states = ((window as { __ACE_DESIGN__?: string }).__ACE_DESIGN__ || "").split(" ");

export const shows = (state: string) => states.includes(state);
