import type { RuleType } from '../types/database';

/** Plain-language explanation of each rule type (the calculation itself lives in the database). */
export const RULE_TYPE_HELP: Record<RuleType, string> = {
  Fixed_Per_Unit: 'Partner B (Amin) receives the rate × quantity sold. Partner A (KaLi Motor) receives revenue minus that.',
  Fixed_Per_Job: 'Partner B receives the rate × number of jobs. Partner A receives the remaining revenue.',
  Fixed_Per_Service: 'Partner B receives the rate × number of services. Partner A receives the remaining revenue.',
  Shared_50: 'Revenue is split 50/50 between Partner A and Partner B.',
};
