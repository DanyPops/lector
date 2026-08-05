export interface Account {
	readonly balance: number;
}

export function withdraw(account: Account, amount: number): Account {
	if (amount <= 0) throw new Error("invalid amount");
	if (amount > account.balance) throw new Error("insufficient funds");
	return { balance: account.balance - amount };
}
