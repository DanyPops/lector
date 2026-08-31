/** Raised when Git rejects the caller's extended regular expression before searching history. */
export class InvalidGitSearchPattern extends Error {
	constructor() {
		super("Git history search pattern is not a valid extended regular expression");
		this.name = "InvalidGitSearchPattern";
	}
}
