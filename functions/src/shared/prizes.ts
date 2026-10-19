export interface Prize {
  readonly name: string;
  readonly qualifyingRoll: string;
}

export const PRIZES: readonly Prize[] = [
  { name: 'Steady Aim', qualifyingRoll: 'ranged attack roll' },
  { name: 'Close Encounter', qualifyingRoll: 'melee attack roll' },
  { name: 'Quick Start', qualifyingRoll: 'initiative roll' },
  { name: 'Fast Reflexes', qualifyingRoll: 'Reflex save' },
  { name: 'Iron Constitution', qualifyingRoll: 'Fortitude save' },
  { name: 'Mental Shield', qualifyingRoll: 'Will save' },
  { name: 'Sharp Eyes', qualifyingRoll: 'Perception check to spot something' },
  { name: 'Ghost Protocol', qualifyingRoll: 'check to sneak or hide' },
  { name: 'Silver Tongue', qualifyingRoll: 'check to persuade someone' },
  { name: 'Convincing Bluff', qualifyingRoll: 'check to deceive someone' },
  { name: 'Commanding Presence', qualifyingRoll: 'check to intimidate someone' },
  { name: 'Access Granted', qualifyingRoll: 'check to access or hack a computer' },
  { name: 'Field Mechanic', qualifyingRoll: 'check to repair equipment' },
  { name: 'Precision Tools', qualifyingRoll: 'check to pick a lock or disable a device' },
  { name: 'Steady Hands', qualifyingRoll: 'check to provide medical treatment' },
  { name: 'Ace Pilot', qualifyingRoll: 'check to operate a vehicle' },
  { name: 'Power Through', qualifyingRoll: 'check to climb, jump, or swim' },
  { name: 'Perfect Balance', qualifyingRoll: 'check to balance or tumble' },
  { name: 'Database Recall', qualifyingRoll: 'check to recall information' },
  { name: 'Trailblazer', qualifyingRoll: 'check to track or navigate through wilderness' },
];

export function selectPrize(random: () => number = Math.random): Prize {
  return PRIZES[Math.floor(random() * PRIZES.length)];
}
