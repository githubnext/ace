/**
 * Each deployment of the team's services belongs to one tailnet, set as `TAILNET` when it is
 * deployed; serving another tailnet means deploying new services. Hosts present
 * HMAC-SHA256(ACE_SECRET, tailnet) with their live tailnet's MagicDNS suffix, so a host on another
 * tailnet is refused even with the right secret.
 *
 * This scopes the services; it is not a security boundary. The suffix is public (certificate
 * transparency logs list it), so anyone holding `ACE_SECRET` can derive the credential from
 * anywhere. See docs/architecture.md#the-team.
 */
export async function credential(secret: string, tailnet: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(tailnet));
	return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
