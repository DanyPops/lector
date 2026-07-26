class LegacyGateway {
	charge(amountCents) {
		return `legacy:${amountCents}`;
	}
}

module.exports = { LegacyGateway };
