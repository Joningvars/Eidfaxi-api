/**
 * Class_Type classification and per-type policy module for Landsmót graphics.
 *
 * This module owns the Class_Type constants, the per-type policy table, and the
 * pure helpers that downstream modules (normalizer.js, server.js,
 * event-registry.js) consume instead of branching on class type ad hoc.
 *
 * Task 1.1 scaffolds the module structure: constants, the default class type,
 * the policy table + `getClassTypePolicy`, `finalsSeatCount`, and the identity
 * `scaleSpeedTime` hook. The classifier (1.2), formatting helpers (1.3),
 * `averageMarks` (1.4), and `positionColorName`/`applyFieldMapping` (1.5) are
 * implemented in subsequent tasks.
 */

/**
 * Class_Type enumeration. String values are the canonical Class_Type ids that
 * flow from event-registry.js through the normalizer to the server output.
 */
export const ClassType = {
  ADULT_QUALITY: 'Adult_Quality_Class',
  YOUNGER_QUALITY: 'Younger_Quality_Class',
  SPORT_TOLT: 'Sport_Tolt_Class',
  GAEDINGASKEID: 'Gaedingaskeid_Class',
  BREEDING_SHOW: 'Breeding_Show_Class',
};

/**
 * Default used for unmatched / missing class names. Behaves exactly like
 * Sport_Tolt_Class, preserving pre-Landsmót behavior (Requirements 1.7, 1.8).
 */
export const DEFAULT_CLASS_TYPE = ClassType.SPORT_TOLT;

/**
 * @typedef {Object} ClassTypePolicy
 * @property {'competitor-horse'|'rider-primary'} fieldMode
 *   competitor-horse: horse→Knapi, rider→Hestur, horseClub→Lid (adult quality)
 *   rider-primary:    rider→Knapi, horse→Hestur, riderClub→Lid (all others)
 * @property {'horse'|'rider'} clubSource       which adildarfelag feeds Lid
 * @property {1|2} judgeDecimals                digits for E1..E5 / D-fields
 * @property {2} finalDecimals                  digits for the Final_Score
 * @property {'sum5'|'drop-high-low'|null} averaging divisor 5 vs drop→divisor 3
 * @property {8|5|null} finalsSeats             finalist seats
 * @property {string[]} colorPalette            index 0 = position 1
 * @property {'standard'|'gaedingaskeid'|'breeding'} layout
 */

/**
 * Color palette used by the quality classes (positions 1..8).
 */
const QUALITY_PALETTE = [
  'red',
  'yellow',
  'green',
  'blue',
  'white',
  'black',
  'pink',
  'orange',
];

/**
 * Color palette used by tölt / gæðingaskeið classes (positions 1..5).
 */
const TOLT_PALETTE = ['red', 'yellow', 'green', 'blue', 'white'];

/**
 * Per-Class_Type policy table. Values are taken exactly from the design's
 * "Concrete policies" table and the ClassTypePolicy typedef.
 *
 * @type {Record<string, ClassTypePolicy>}
 */
const CLASS_TYPE_POLICIES = {
  [ClassType.ADULT_QUALITY]: {
    fieldMode: 'competitor-horse',
    clubSource: 'horse',
    judgeDecimals: 2,
    finalDecimals: 2,
    averaging: 'sum5',
    finalsSeats: 8,
    colorPalette: QUALITY_PALETTE,
    layout: 'standard',
  },
  [ClassType.YOUNGER_QUALITY]: {
    fieldMode: 'rider-primary',
    clubSource: 'rider',
    judgeDecimals: 2,
    finalDecimals: 2,
    averaging: 'sum5',
    finalsSeats: 8,
    colorPalette: QUALITY_PALETTE,
    layout: 'standard',
  },
  [ClassType.SPORT_TOLT]: {
    fieldMode: 'rider-primary',
    clubSource: 'rider',
    judgeDecimals: 1,
    finalDecimals: 2,
    averaging: 'drop-high-low',
    finalsSeats: 5,
    colorPalette: TOLT_PALETTE,
    layout: 'standard',
  },
  [ClassType.GAEDINGASKEID]: {
    fieldMode: 'rider-primary',
    clubSource: 'rider',
    judgeDecimals: 1,
    finalDecimals: 2,
    averaging: null,
    finalsSeats: 5,
    colorPalette: TOLT_PALETTE,
    layout: 'gaedingaskeid',
  },
  [ClassType.BREEDING_SHOW]: {
    fieldMode: 'rider-primary',
    clubSource: 'rider',
    judgeDecimals: 2,
    finalDecimals: 2,
    averaging: null,
    finalsSeats: null,
    colorPalette: [],
    layout: 'breeding',
  },
};

/**
 * Exact adult quality-class names (Requirement 1.2). Compared after trimming
 * and lower-casing, so entries here are the canonical lower-case forms.
 */
const ADULT_QUALITY_NAMES = new Set([
  'a flokkur',
  'b flokkur',
  'b flokkur áhugamenn',
]);

/**
 * Exact younger quality-class names (Requirement 1.3).
 */
const YOUNGER_QUALITY_NAMES = new Set([
  'unglingaflokkur',
  'b flokkur ungmenna',
  'barnaflokkur',
  'a flokkur ungmenna',
]);

/**
 * Gæðingaskeið distance/discipline tokens (Requirement 1.5). A trimmed,
 * lower-cased className or disciplineText containing any of these resolves to
 * Gaedingaskeid_Class.
 */
const GAEDINGASKEID_TOKENS = ['gæðingaskeið', '100 m', '150 m', '250 m skeið'];

/**
 * Normalize a metadata string for matching: coerce non-strings to empty, trim
 * surrounding whitespace, and lower-case (case-insensitive matching). Returns
 * an empty string for null/undefined/non-string inputs so callers never throw.
 *
 * @param {*} value
 * @returns {string}
 */
function normalizeMeta(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Detect a gæðingakeppni (quality) class from Sportfengur test-row metadata,
 * checking BOTH fields — in real Sportfengur data the class name usually lives
 * in `keppnisgrein` (disciplineText, e.g. "A flokkur") while `flokkur_nafn`
 * (className) holds the division (e.g. "Gæðingaflokkur 1").
 *
 * Matches the exact adult/younger quality names, plus prefixed variants such as
 * "Unglingaflokkur gæðinga" / "Barnaflokkur gæðinga". Pure, total,
 * never-throwing. Used to pick the gait-averaging strategy (quality classes
 * count all five judges; sport classes drop highest+lowest) WITHOUT changing
 * the stored Class_Type (field mapping, palettes and seat counts are untouched).
 *
 * @param {{ className?: string, disciplineText?: string }} [meta]
 * @returns {boolean}
 */
export function isQualityClassName(meta) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const candidates = [
    normalizeMeta(source.className),
    normalizeMeta(source.disciplineText),
  ];
  const names = [...ADULT_QUALITY_NAMES, ...YOUNGER_QUALITY_NAMES];
  return candidates.some(
    (value) =>
      value !== '' &&
      names.some((name) => value === name || value.startsWith(`${name} `)),
  );
}

/**
 * Classify a competition class into a Class_Type from its Sportfengur metadata.
 *
 * Pure, total, and never-throwing. Matching is case-insensitive and
 * whitespace-trimmed. Precedence is explicit and ordered so overlapping names
 * resolve deterministically (Requirement 1, design classification rules):
 *
 *   1. Exact adult quality names        → Adult_Quality_Class   (Req 1.2)
 *   2. Exact younger quality names      → Younger_Quality_Class (Req 1.3)
 *   3. Gæðingaskeið discipline/distance → Gaedingaskeid_Class   (Req 1.5)
 *   4. Name contains "tölt"             → Sport_Tolt_Class      (Req 1.4)
 *   5. Breeding show (kynbótasýning)    → Breeding_Show_Class
 *   6. Anything else / empty / missing  → DEFAULT_CLASS_TYPE    (Req 1.7, 1.8)
 *
 * Adult/younger exact names are checked before the "tölt" substring so a youth
 * class whose name happens to include "tölt" wording is not misrouted (design
 * precedence note).
 *
 * @param {{ className?: string, disciplineText?: string }} [meta]
 * @returns {string} one of ClassType.* (DEFAULT_CLASS_TYPE when unmatched/empty)
 */
export function classifyClassType(meta) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const className = normalizeMeta(source.className);
  const disciplineText = normalizeMeta(source.disciplineText);

  // 1 & 2: exact adult / younger quality-class names take highest precedence.
  if (ADULT_QUALITY_NAMES.has(className)) {
    return ClassType.ADULT_QUALITY;
  }
  if (YOUNGER_QUALITY_NAMES.has(className)) {
    return ClassType.YOUNGER_QUALITY;
  }

  // 3: gæðingaskeið by discipline keyword or distance, in name or discipline.
  const combined = `${className} ${disciplineText}`;
  if (GAEDINGASKEID_TOKENS.some((token) => combined.includes(token))) {
    return ClassType.GAEDINGASKEID;
  }

  // 4: any tölt class.
  if (className.includes('tölt')) {
    return ClassType.SPORT_TOLT;
  }

  // 5: breeding show (kynbótasýning).
  if (
    className.includes('kynbótasýning') ||
    disciplineText.includes('kynbótasýning')
  ) {
    return ClassType.BREEDING_SHOW;
  }

  // 6: unmatched, empty, or missing → default (Sport_Tolt behavior).
  return DEFAULT_CLASS_TYPE;
}

/**
 * Return the policy object for a Class_Type. Unknown / missing class types fall
 * back to the default (Sport_Tolt) policy so callers never receive undefined.
 *
 * @param {string} classType one of ClassType.*
 * @returns {ClassTypePolicy}
 */
export function getClassTypePolicy(classType) {
  return (
    CLASS_TYPE_POLICIES[classType] || CLASS_TYPE_POLICIES[DEFAULT_CLASS_TYPE]
  );
}

/**
 * Number of finalist seats for a Class_Type: 8 for quality classes, 5 for tölt
 * (and other rider-primary classes). Falls back to the default policy's seat
 * count for unknown class types (Requirements 9.1, 9.2).
 *
 * @param {string} classType one of ClassType.*
 * @returns {8|5|null}
 */
export function finalsSeatCount(classType) {
  return getClassTypePolicy(classType).finalsSeats;
}

/**
 * Single scaling hook for the gæðingaskeið Speed_Time. Identity today: the time
 * is emitted exactly as received from Sportfengur with no scaling transform
 * (Requirement 7.4, and the design's open question). Kept as a named seam so a
 * future scaling decision lives in exactly one place.
 *
 * @param {*} rawTime
 * @returns {*} rawTime unchanged
 */
export function scaleSpeedTime(rawTime) {
  return rawTime;
}

/**
 * Parse a possibly-Icelandic numeric value into a finite JS number.
 *
 * Mirrors the normalizer's comma handling: a single comma decimal separator is
 * normalized to a dot before parsing (see src/vmix/normalizer.js `roundScore`).
 * Returns `null` for null/undefined/empty/non-finite/unparseable input so
 * callers can emit an empty string.
 *
 * @param {*} value
 * @returns {number|null}
 */
function parseNumeric(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const str = String(value).trim().replace(',', '.');
  if (str === '') return null;
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

/**
 * Round `num` to `digits` decimals, half-up at the target precision, corrected
 * for binary floating-point representation error.
 *
 * The value is shifted using string exponent notation (`"8.005e2"`) so the
 * decimal magnitude is parsed as the nearest double to the *decimal* value
 * rather than accumulating the error of `num * 10**digits`. This is why
 * `8.005` rounds to `8.01` (two decimals) and `7.25` to `7.3` (one decimal),
 * which a naive `Math.round(x * 100) / 100` mis-rounds. `Math.round` breaks
 * ties toward +∞ (half-up) for the non-negative scores this feature formats.
 *
 * @param {number} num   finite number
 * @param {number} digits non-negative integer
 * @returns {number}
 */
function roundHalfUp(num, digits) {
  const shifted = Math.round(Number(`${num}e${digits}`));
  const result = Number(`${shifted}e${-digits}`);
  // Fallback for exotic inputs (e.g. exponential-notation source) where the
  // string shift yields NaN; keep a defined numeric result.
  if (!Number.isFinite(result)) {
    const factor = 10 ** digits;
    return Math.round(num * factor) / factor;
  }
  return result;
}

/**
 * Format a numeric value as a string with EXACTLY `digits` digits after the
 * decimal separator, including trailing zeros, rounding half-up at the target
 * precision (corrected for binary FP error — e.g. `formatDecimals(8.005, 2)`
 * ⇒ `"8.01"`, `formatDecimals(7.25, 1)` ⇒ `"7.3"`).
 *
 * Returns the empty string for non-numeric / unavailable input (null,
 * undefined, `''`, NaN, non-finite, unparseable). A comma decimal separator is
 * normalized to a dot before parsing (Icelandic decimals).
 *
 * @param {*} value
 * @param {number} digits number of decimal places
 * @returns {string} formatted number, or '' when unavailable/non-numeric
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 7.5, 7.6, 10.3, 12.2
 */
export function formatDecimals(value, digits) {
  const num = parseNumeric(value);
  if (num === null) return '';
  return roundHalfUp(num, digits).toFixed(digits);
}

/**
 * Format the gæðingaskeið Speed_Time as a single numeric value with UP TO
 * `maxDigits` decimals and NO trailing-zero padding (e.g. `7.97` ⇒ `"7.97"`,
 * `18.97` ⇒ `"18.97"`, `20` ⇒ `"20"`, `19.5` ⇒ `"19.5"`).
 *
 * Returns the empty string when the value is unavailable / non-numeric. A comma
 * decimal separator is normalized to a dot before parsing.
 *
 * @param {*} value
 * @param {number} [maxDigits=2] maximum number of decimal places
 * @returns {string} formatted number, or '' when unavailable/non-numeric
 *
 * Requirement: 7.4
 */
export function formatSpeedTime(value, maxDigits = 2) {
  const num = parseNumeric(value);
  if (num === null) return '';
  const rounded = roundHalfUp(num, maxDigits);
  // toFixed then re-parse drops trailing-zero padding while keeping the
  // rounding stable at `maxDigits`.
  return String(Number(rounded.toFixed(maxDigits)));
}

/**
 * Compute a class-type average from a set of Judge_Marks.
 *
 * Both strategies require EXACTLY five numeric marks to produce a value; when
 * fewer than five numeric marks are available the function returns `null` so
 * callers can emit an empty average (Requirements 6.4, 9.6). Marks are parsed
 * tolerantly via the module's `parseNumeric` helper (Icelandic comma decimals
 * normalized to dots; non-numeric / null / blank entries are simply not counted
 * as available marks). The function is total and never throws.
 *
 * Strategies:
 * - `'sum5'`         : sum of all five numeric marks divided by 5, with NO mark
 *                      removed (Requirements 6.1, 6.2, 9.5).
 * - `'drop-high-low'`: remove exactly one instance equal to the maximum value
 *                      and exactly one instance equal to the minimum value
 *                      (a single instance of each, even when duplicate values
 *                      tie), then return the mean of the remaining three
 *                      (sum ÷ 3) (Requirement 6.3).
 *
 * Returns a JS number (not a formatted string) so callers can format the result
 * via `formatDecimals`. Returns `null` for an unknown / null strategy.
 *
 * @param {Array<*>} marks    candidate Judge_Marks (parsed tolerantly)
 * @param {'sum5'|'drop-high-low'} strategy averaging strategy
 * @returns {number|null} the average, or null when < 5 numeric marks / unknown strategy
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 9.5, 9.6
 */
export function averageMarks(marks, strategy) {
  // Collect only the numeric marks; non-numeric entries are not counted.
  const numeric = [];
  if (Array.isArray(marks)) {
    for (const mark of marks) {
      const parsed = parseNumeric(mark);
      if (parsed !== null) numeric.push(parsed);
    }
  }

  // Both strategies require exactly five numeric marks.
  if (numeric.length !== 5) return null;

  if (strategy === 'sum5') {
    const sum = numeric.reduce((acc, n) => acc + n, 0);
    return sum / 5;
  }

  if (strategy === 'drop-high-low') {
    const max = Math.max(...numeric);
    const min = Math.min(...numeric);
    // Remove a single instance of the max and a single instance of the min,
    // honoring ties (e.g. [8,8,8,10,6] drops one 10 and one 6, keeping 8,8,8).
    const remaining = [...numeric];
    remaining.splice(remaining.indexOf(max), 1);
    remaining.splice(remaining.indexOf(min), 1);
    const sum = remaining.reduce((acc, n) => acc + n, 0);
    return sum / 3;
  }

  // Unknown / null strategy.
  return null;
}

/**
 * Map a finishing/start position to its color name in a palette.
 *
 * Total and never-throwing: returns `palette[position - 1]` for an integer
 * `position` in `1..palette.length`, and the empty string for any other input
 * (absent, non-positive, non-integer, or out of range). A non-array palette is
 * treated as empty (always yields '').
 *
 * @param {*} position       1-based finishing/start position
 * @param {string[]} palette color names; index 0 = position 1
 * @returns {string} the color name, or '' when out of range / invalid
 *
 * Requirements: 11.1, 11.2, 11.5
 */
export function positionColorName(position, palette) {
  if (!Array.isArray(palette) || palette.length === 0) return '';
  if (typeof position !== 'number' || !Number.isInteger(position)) return '';
  if (position < 1 || position > palette.length) return '';
  const color = palette[position - 1];
  return typeof color === 'string' ? color : '';
}

/**
 * Map an entry's rider/horse names and clubs into the canonical
 * `{ Knapi, Hestur, Lid }` output fields according to the policy's field mode.
 *
 *   - `competitor-horse` (adult quality): horse→Knapi, rider→Hestur,
 *     horseClub→Lid.
 *   - `rider-primary` (all others): rider→Knapi, horse→Hestur, riderClub→Lid.
 *
 * Missing / non-string values map to empty strings so no field is dropped and
 * the mapping never fails the entry (Requirements 2.7, 3.5, 3.6, 4.4, 4.5). An
 * absent or unknown policy defaults to `rider-primary`.
 *
 * @param {{ riderName?: *, horseName?: *, riderClub?: *, horseClub?: * }} fields
 * @param {ClassTypePolicy} policy
 * @returns {{ Knapi: string, Hestur: string, Lid: string }}
 *
 * Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 11 (n/a)
 */
export function applyFieldMapping(fields, policy) {
  const source = fields && typeof fields === 'object' ? fields : {};
  const asText = (value) => (typeof value === 'string' ? value : '');
  const riderName = asText(source.riderName);
  const horseName = asText(source.horseName);
  const riderClub = asText(source.riderClub);
  const horseClub = asText(source.horseClub);

  if (policy && policy.fieldMode === 'competitor-horse') {
    return { Knapi: horseName, Hestur: riderName, Lid: horseClub };
  }

  // Default: rider-primary.
  return { Knapi: riderName, Hestur: horseName, Lid: riderClub };
}
