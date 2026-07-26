export function createLegacyClient(gateway) {
	return { charge: (amountCents) => gateway.charge(amountCents) };
}
