export interface ReceiptViewProps {
	readonly transactionId: string;
}

export function ReceiptView({ transactionId }: ReceiptViewProps) {
	return <output data-transaction={transactionId}>{transactionId}</output>;
}
