// --- [FEAT:breeding] begin ---

/**
 * 与链码 `BreedingContract` 保持一致的常量。
 * 费用/等级以链上 `GetBreedingConfig` 为准（前端展示读接口），这里的值用于后端预校验与文档。
 */
export const BREED_MIN_LEVEL = 20;
export const BREED_COST = 200;

/** 派生流区段（docs/feature-breeding.md §2）。 */
export const IV_BLOCK = 50000;
export const NATURE_SLOT = 50012;
export const SHINY_SLOT = 50013;
export const SHINY_DENOMINATOR = 4096;

export const IV_CHOICE_PARENT_A = 0.4;
export const IV_CHOICE_PARENT_B = 0.8;

export const IV_KEYS = ['hp', 'atk', 'def', 'spatk', 'spdef', 'speed'] as const;

// --- [FEAT:breeding] end ---
