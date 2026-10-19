// Approved five-by-five masks. The free center never needs a submitted number.
export interface Pattern { readonly id: string; readonly name: string; readonly squares: readonly number[] }
export const LINES: readonly (readonly number[])[] = [
  ...Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, col) => row * 5 + col)),
  ...Array.from({ length: 5 }, (_, col) => Array.from({ length: 5 }, (_, row) => row * 5 + col)),
  [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
];
const mask = (id: string, name: string, rows: string[]): Pattern => ({ id, name, squares: rows.join('').split('').flatMap((v, i) => v === '1' ? [i] : []) });
export const SHAPES: readonly Pattern[] = [
  mask("four-corners", "Four corners", ["10001", "00000", "00000", "00000", "10001"]),
  mask("blackout", "Blackout", ["11111", "11111", "11111", "11111", "11111"]),
  mask("airplane", "Airplane", ["00100", "00100", "11111", "00100", "01110"]),
  mask("wine-glass", "Wine glass", ["11111", "01110", "00100", "00100", "01110"]),
  mask("heart", "Heart", ["01010", "11111", "11111", "01110", "00100"]),
  mask("turtle", "Turtle", ["00100", "01110", "11111", "01110", "01010"]),
  mask("bow-tie", "Bow tie", ["10001", "11011", "01110", "11011", "10001"]),
  mask("outside-edge", "Outside edge", ["11111", "10001", "10001", "10001", "11111"]),
  mask("ladder", "Ladder", ["01010", "01110", "01010", "01110", "01010"]),
  mask("windmill", "Windmill", ["11011", "11011", "00000", "11011", "11011"]),
  mask("christmas-tree", "Christmas tree", ["00100", "01110", "11111", "00100", "01110"]),
  mask("reindeer", "Reindeer", ["10001", "10101", "01110", "01110", "01010"]),
  mask("witch-s-hat", "Witch's Hat", ["00100", "00100", "01110", "01110", "11111"]),
  mask("bunny-ears", "Bunny ears", ["01010", "01010", "01110", "11111", "01110"]),
  mask("cupid-s-arrow", "Cupid's Arrow", ["00111", "00011", "00101", "01000", "10000"]),
];
export const CHARACTERS: readonly Pattern[] = [
  mask("character-A", "Letter A", ["01110", "10001", "11111", "10001", "10001"]),
  mask("character-B", "Letter B", ["11110", "10001", "11110", "10001", "11110"]),
  mask("character-C", "Letter C", ["01111", "10000", "10000", "10000", "01111"]),
  mask("character-D", "Letter D", ["11110", "10001", "10001", "10001", "11110"]),
  mask("character-E", "Letter E", ["11111", "10000", "11110", "10000", "11111"]),
  mask("character-F", "Letter F", ["11111", "10000", "11110", "10000", "10000"]),
  mask("character-G", "Letter G", ["01111", "10000", "10111", "10001", "01111"]),
  mask("character-H", "Letter H", ["10001", "10001", "11111", "10001", "10001"]),
  mask("character-I", "Letter I", ["11111", "00100", "00100", "00100", "11111"]),
  mask("character-J", "Letter J", ["00111", "00010", "00010", "10010", "01100"]),
  mask("character-K", "Letter K", ["10001", "10010", "11100", "10010", "10001"]),
  mask("character-L", "Letter L", ["10000", "10000", "10000", "10000", "11111"]),
  mask("character-M", "Letter M", ["10001", "11011", "10101", "10001", "10001"]),
  mask("character-N", "Letter N", ["10001", "11001", "10101", "10011", "10001"]),
  mask("character-O", "Letter O", ["01110", "10001", "10001", "10001", "01110"]),
  mask("character-P", "Letter P", ["11110", "10001", "11110", "10000", "10000"]),
  mask("character-Q", "Letter Q", ["01110", "10001", "10101", "10010", "01101"]),
  mask("character-R", "Letter R", ["11110", "10001", "11110", "10010", "10001"]),
  mask("character-S", "Letter S", ["01111", "10000", "01110", "00001", "11110"]),
  mask("character-T", "Letter T", ["11111", "00100", "00100", "00100", "00100"]),
  mask("character-U", "Letter U", ["10001", "10001", "10001", "10001", "01110"]),
  mask("character-V", "Letter V", ["10001", "10001", "10001", "01010", "00100"]),
  mask("character-W", "Letter W", ["10001", "10001", "10101", "11011", "10001"]),
  mask("character-X", "Letter X", ["10001", "01010", "00100", "01010", "10001"]),
  mask("character-Y", "Letter Y", ["10001", "01010", "00100", "00100", "00100"]),
  mask("character-Z", "Letter Z", ["11111", "00010", "00100", "01000", "11111"]),
  mask("character-0", "Number 0", ["01110", "10001", "10101", "10001", "01110"]),
  mask("character-1", "Number 1", ["00100", "01100", "00100", "00100", "01110"]),
  mask("character-2", "Number 2", ["01110", "10001", "00010", "00100", "11111"]),
  mask("character-3", "Number 3", ["11110", "00001", "01110", "00001", "11110"]),
  mask("character-4", "Number 4", ["10010", "10010", "11111", "00010", "00010"]),
  mask("character-5", "Number 5", ["11111", "10000", "11110", "00001", "11110"]),
  mask("character-6", "Number 6", ["01111", "10000", "11110", "10001", "01110"]),
  mask("character-7", "Number 7", ["11111", "00001", "00010", "00100", "01000"]),
  mask("character-8", "Number 8", ["01110", "10001", "01110", "10001", "01110"]),
  mask("character-9", "Number 9", ["01110", "10001", "01111", "00001", "11110"]),
];

export const SINGLE_LINE: Pattern = { id: 'single-line', name: 'Single line', squares: LINES[1] };
export const TWO_LINES: Pattern = { id: 'two-lines', name: 'Two lines', squares: [...LINES[1], ...LINES[3]] };
export const PATTERNS: readonly Pattern[] = [SINGLE_LINE, TWO_LINES, ...SHAPES, ...CHARACTERS];
export const getPattern = (id?: string): Pattern => PATTERNS.find(pattern => pattern.id === id) ?? SINGLE_LINE;
export const isPattern = (id: unknown): id is string => typeof id === 'string' && PATTERNS.some(pattern => pattern.id === id);

// Equal chance for each of the 18 categories; characters then draw uniformly from A–Z / 0–9.
export function selectPattern(random: () => number = Math.random): string {
  const category = Math.floor(random() * 18);
  if (category === 0) return SINGLE_LINE.id;
  if (category === 1) return TWO_LINES.id;
  if (category === 2) return CHARACTERS[Math.floor(random() * CHARACTERS.length)].id;
  return SHAPES[category - 3].id;
}
export function completedPatterns(id: string | undefined, marked: (index: number) => boolean): readonly (readonly number[])[] {
  const pattern = getPattern(id);
  if (pattern.id === 'single-line' || pattern.id === 'two-lines') {
    const complete = LINES.filter(line => line.every(marked));
    return complete.length >= (pattern.id === 'two-lines' ? 2 : 1) ? complete : [];
  }
  return pattern.squares.every(marked) ? [pattern.squares] : [];
}
export function patternHelp(id?: string): string {
  const pattern = getPattern(id);
  if (pattern.id === 'single-line') return 'Outlined squares show an example. Any row, column or diagonal wins.';
  if (pattern.id === 'two-lines') return 'Outlined squares show an example. Any two distinct rows, columns or diagonals win; intersections count.';
  return 'Complete all outlined squares to win. Extra marks are allowed; the center is always free.';
}
