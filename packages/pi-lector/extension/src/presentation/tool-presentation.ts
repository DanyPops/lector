export type PresentationFamily =
	| "source"
	| "markdown"
	| "symbols"
	| "locations"
	| "diagnostics"
	| "diff"
	| "mutation"
	| "status"
	| "table"
	| "tree"
	| "candidates"
	| "semantic-text";

interface PresentationPathSpec {
	readonly title: string;
	readonly family: PresentationFamily;
}

interface ToolPresentationSpec extends PresentationPathSpec {
	readonly actions?: Readonly<Record<string, PresentationPathSpec>>;
}

export const LECTOR_TOOL_PRESENTATION_SPECS: Readonly<Record<string, ToolPresentationSpec>> = {
	read: { title: "Read File", family: "source" },
	write: { title: "Write File", family: "mutation" },
	edit: { title: "Edit File", family: "diff" },
	find_symbols: { title: "Find Symbols", family: "symbols" },
	localize_context: { title: "Localize Context", family: "candidates" },
	go_to_definition: { title: "Go to Definition", family: "locations" },
	go_to_implementation: { title: "Go to Implementation", family: "locations" },
	find_references: { title: "Find References", family: "locations" },
	hover: { title: "Hover", family: "markdown" },
	document_symbols: { title: "Document Symbols", family: "tree" },
	diagnostics: { title: "Diagnostics", family: "diagnostics" },
	code_action_preview: { title: "Preview Code Actions", family: "candidates" },
	code_action_apply: { title: "Apply Code Action", family: "mutation" },
	diagnostic_delta: { title: "Diagnostic Delta", family: "diagnostics" },
	call_hierarchy: {
		title: "Call Hierarchy",
		family: "tree",
		actions: {
			prepare: { title: "Prepare Call Hierarchy", family: "symbols" },
			incoming: { title: "Incoming Calls", family: "tree" },
			outgoing: { title: "Outgoing Calls", family: "tree" },
		},
	},
	type_hierarchy: {
		title: "Type Hierarchy",
		family: "tree",
		actions: {
			prepare: { title: "Prepare Type Hierarchy", family: "symbols" },
			supertypes: { title: "Supertypes", family: "tree" },
			subtypes: { title: "Subtypes", family: "tree" },
		},
	},
	impact_analysis: { title: "Impact Analysis", family: "tree" },
	reference_based_rename: { title: "Rename File by References", family: "mutation" },
	rename: {
		title: "Rename Symbol",
		family: "mutation",
		actions: {
			prepare: { title: "Prepare Rename", family: "semantic-text" },
			apply: { title: "Rename Symbol", family: "mutation" },
		},
	},
	symbol_annotations: {
		title: "Symbol Annotations",
		family: "semantic-text",
		actions: {
			create: { title: "Create Symbol Annotation", family: "mutation" },
			get: { title: "Show Symbol Annotation", family: "markdown" },
			list: { title: "List Symbol Annotations", family: "table" },
			refresh: { title: "Refresh Symbol Annotation", family: "mutation" },
			scrub: { title: "Scrub Symbol Annotation", family: "mutation" },
			restore: { title: "Restore Symbol Annotation", family: "mutation" },
			contain: { title: "Contain Symbol Annotation", family: "mutation" },
			uncontain: { title: "Uncontain Symbol Annotation", family: "mutation" },
			tree: { title: "Annotation Tree", family: "tree" },
		},
	},
	reachable_from: { title: "Reachable Symbols", family: "tree" },
	workspace_map: { title: "Workspace Map", family: "symbols" },
	workspace_cache: {
		title: "Workspace Cache",
		family: "status",
		actions: {
			status: { title: "Workspace Cache Status", family: "status" },
			populate: { title: "Populate Workspace Cache", family: "status" },
			wait: { title: "Wait for Cache Job", family: "status" },
			job_status: { title: "Cache Job Status", family: "status" },
			release: { title: "Release Workspace", family: "mutation" },
		},
	},
	git: {
		title: "Git",
		family: "semantic-text",
		actions: {
			status: { title: "Git Status", family: "status" },
			log: { title: "Git Log", family: "table" },
			diff: { title: "Git Diff", family: "diff" },
			"compare-symbol": { title: "Compare Symbol", family: "diff" },
			show: { title: "Show File at Git Ref", family: "source" },
			"grep-ref": { title: "Search Git Ref", family: "locations" },
			"grep-history": { title: "Search Git History", family: "locations" },
			"ls-ref": { title: "List Files at Git Ref", family: "table" },
			"is-ancestor": { title: "Check Git Ancestry", family: "semantic-text" },
			"worktree-add": { title: "Create Git Worktree", family: "mutation" },
			"worktree-remove": { title: "Remove Git Worktree", family: "mutation" },
		},
	},
	search_code: { title: "Search Code", family: "locations" },
	find_files: { title: "Find Files", family: "table" },
	line_edit: { title: "Edit Lines", family: "diff" },
	apply_patch: { title: "Apply Patch", family: "diff" },
	mutation_history: {
		title: "Mutation History",
		family: "table",
		actions: {
			list: { title: "Mutation History", family: "table" },
			revert: { title: "Revert Mutation", family: "mutation" },
			"revert-transaction": { title: "Revert Transaction", family: "mutation" },
		},
	},
	package_source: {
		title: "Package Source",
		family: "semantic-text",
		actions: {
			resolve: { title: "Resolve Package Source", family: "semantic-text" },
			list: { title: "List Package Sources", family: "table" },
			remove: { title: "Remove Package Source", family: "mutation" },
			clean: { title: "Clean Package Sources", family: "mutation" },
		},
	},
	repo_cache: {
		title: "Repository Cache",
		family: "semantic-text",
		actions: {
			fetch: { title: "Fetch Repository", family: "status" },
			list: { title: "List Repository Cache", family: "table" },
			evict: { title: "Evict Repository", family: "mutation" },
		},
	},
	external_search: {
		title: "External Search",
		family: "candidates",
		actions: {
			github_repos: { title: "Search GitHub Repositories", family: "candidates" },
			npm_packages: { title: "Search npm Packages", family: "candidates" },
			sourcegraph_code: { title: "Search Public Code", family: "candidates" },
		},
	},
	find_symbols_across_projects: { title: "Find Symbols Across Projects", family: "symbols" },
	search_code_across_projects: { title: "Search Code Across Projects", family: "locations" },
};

export function presentationTitle(toolName: string, action?: string): string {
	const spec = LECTOR_TOOL_PRESENTATION_SPECS[toolName];
	if (!spec) throw new Error(`no presentation specification for ${toolName}`);
	return (action ? spec.actions?.[action]?.title : undefined) ?? spec.title;
}

export function presentationFamily(toolName: string, action?: string): PresentationFamily {
	const spec = LECTOR_TOOL_PRESENTATION_SPECS[toolName];
	if (!spec) throw new Error(`no presentation specification for ${toolName}`);
	return (action ? spec.actions?.[action]?.family : undefined) ?? spec.family;
}

export function presentationPathCount(): number {
	return Object.values(LECTOR_TOOL_PRESENTATION_SPECS).reduce((count, spec) => count + (spec.actions ? Object.keys(spec.actions).length : 1), 0);
}
