/** Shared shape for every top-level and workspace-subcommand action registry (WORKSPACE_ACTIONS, PACKAGE_ACTIONS, ...) -- one function taking the remaining argv after the action name. */
export type ActionHandler = (actionArgs: string[]) => Promise<void>;
