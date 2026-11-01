import type { RewardDefinition } from './model';

// Copied from rpg-bingo/functions/src/shared/prizes.ts. These are house rules.
export const REWARDS: readonly RewardDefinition[] = [
  { id: 'steady-aim', name: 'Steady Aim', qualifyingRoll: 'ranged attack roll' },
  { id: 'close-encounter', name: 'Close Encounter', qualifyingRoll: 'melee attack roll' },
  { id: 'quick-start', name: 'Quick Start', qualifyingRoll: 'initiative roll' },
  { id: 'fast-reflexes', name: 'Fast Reflexes', qualifyingRoll: 'Reflex save' },
  { id: 'iron-constitution', name: 'Iron Constitution', qualifyingRoll: 'Fortitude save' },
  { id: 'mental-shield', name: 'Mental Shield', qualifyingRoll: 'Will save' },
  { id: 'sharp-eyes', name: 'Sharp Eyes', qualifyingRoll: 'Perception check to spot something' },
  { id: 'ghost-protocol', name: 'Ghost Protocol', qualifyingRoll: 'check to sneak or hide' },
  { id: 'silver-tongue', name: 'Silver Tongue', qualifyingRoll: 'check to persuade someone' },
  { id: 'convincing-bluff', name: 'Convincing Bluff', qualifyingRoll: 'check to deceive someone' },
  { id: 'commanding-presence', name: 'Commanding Presence', qualifyingRoll: 'check to intimidate someone' },
  { id: 'access-granted', name: 'Access Granted', qualifyingRoll: 'check to access or hack a computer' },
  { id: 'field-mechanic', name: 'Field Mechanic', qualifyingRoll: 'check to repair equipment' },
  { id: 'precision-tools', name: 'Precision Tools', qualifyingRoll: 'check to pick a lock or disable a device' },
  { id: 'steady-hands', name: 'Steady Hands', qualifyingRoll: 'check to provide medical treatment' },
  { id: 'ace-pilot', name: 'Ace Pilot', qualifyingRoll: 'check to operate a vehicle' },
  { id: 'power-through', name: 'Power Through', qualifyingRoll: 'check to climb, jump, or swim' },
  { id: 'perfect-balance', name: 'Perfect Balance', qualifyingRoll: 'check to balance or tumble' },
  { id: 'database-recall', name: 'Database Recall', qualifyingRoll: 'check to recall information' },
  { id: 'trailblazer', name: 'Trailblazer', qualifyingRoll: 'check to track or navigate through wilderness' },
];
export function selectReward(random: () => number): RewardDefinition {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Random source must return [0, 1).');
  return { ...REWARDS[Math.floor(value * REWARDS.length)] };
}
