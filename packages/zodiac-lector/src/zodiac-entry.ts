import { createLectorZodiacContribution } from "./contribution.js";

/**
 * Explicit zodiacd manifest entry. The package owns the contribution and its
 * Lector-daemon adapter; Zodiac only discovers and hosts this default export.
 */
export default createLectorZodiacContribution();
