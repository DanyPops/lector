export function leaf(value: number): number {
	return value + 1;
}

export function middle(value: number): number {
	return leaf(value);
}

export function root(value: number): number {
	return middle(value);
}
