import {
  WORLDFENGUR_BASE_URL,
  WORLDFENGUR_USERNAME,
  WORLDFENGUR_PASSWORD,
} from './config.js';

/**
 * Degradable Worldfengur provider.
 *
 * This module is the single integration point for breeding-show enrichment.
 * The real Worldfengur API client is built separately by a colleague and is
 * plugged in here via `setBreedingClient(...)`. Until a client is injected the
 * provider is inert: `getBreedingRecord` resolves to `null` so that callers
 * (roster-enrichment) degrade to empty breeding fields without failing.
 *
 * Contract:
 *  - `isConfigured()` reflects whether the connection can be used at all
 *    (Worldfengur env/config present AND a client has been injected).
 *  - `getBreedingRecord(isNumber)` NEVER throws. It returns a BreedingRecord
 *    when one is available, or `null` when the provider is unconfigured or when
 *    any error / parse failure occurs. Failures are logged at warn level,
 *    consistent with the roster-cache warn pattern in roster-enrichment.js.
 *  - No data is transmitted beyond the IS-number lookup the feature requires.
 */

/**
 * @typedef {Object} BreedingRecord
 * @property {string} ISNumber            IS registration number.
 * @property {string} horseName           Horse name.
 * @property {string} origin              Uppruni.
 * @property {string} riderName           Rider / handler name.
 * @property {string} dam                 Móðir.
 * @property {string} sire                Faðir.
 * @property {number|string} conformationScore  Raw Sköpulagseinkunn (formatted by caller).
 * @property {string} supplementaryText   Supplementary note ('' when none).
 * @property {string} owner               Eigandi (raw; percentages stripped by caller).
 * @property {string} breeder             Ræktandi.
 */

/**
 * The injected client. A colleague provides an object exposing an async
 * `fetchBreedingRecord(isNumber)` that returns a BreedingRecord-shaped object
 * (or a raw payload this module maps). `null` means no client is wired yet.
 * @type {{ fetchBreedingRecord: (isNumber: string) => Promise<any> } | null}
 */
let breedingClient = null;

/**
 * Wire the colleague's Worldfengur API client. This is the single documented
 * integration point; passing `null` resets the provider to its inert state.
 *
 * @param {{ fetchBreedingRecord: (isNumber: string) => Promise<any> } | null} client
 */
export function setBreedingClient(client) {
  breedingClient = client || null;
}

/**
 * Whether the Worldfengur connection is usable. Requires the connection config
 * to be present (base URL + credentials) and a client to be injected. Reads
 * configuration consistently with src/config.js and other modules.
 *
 * @returns {boolean}
 */
export function isConfigured() {
  const hasConfig = Boolean(
    WORLDFENGUR_BASE_URL && WORLDFENGUR_USERNAME && WORLDFENGUR_PASSWORD,
  );
  return hasConfig && breedingClient !== null;
}

/**
 * Normalize a raw client payload into the BreedingRecord shape. Missing fields
 * become empty strings so downstream formatting is predictable. Throws only if
 * the payload is not an object; callers treat any throw as a parse failure.
 *
 * @param {any} raw
 * @param {string} isNumber
 * @returns {BreedingRecord}
 */
function toBreedingRecord(raw, isNumber) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Malformed Worldfengur record');
  }
  const text = (value) => (value == null ? '' : String(value));
  return {
    ISNumber: text(raw.ISNumber ?? raw.isNumber ?? isNumber),
    horseName: text(raw.horseName ?? raw.name),
    origin: text(raw.origin ?? raw.uppruni),
    riderName: text(raw.riderName ?? raw.knapi),
    dam: text(raw.dam ?? raw.modir),
    sire: text(raw.sire ?? raw.fadir),
    conformationScore: raw.conformationScore ?? raw.skopulag ?? '',
    supplementaryText: text(raw.supplementaryText ?? raw.athugasemd),
    owner: text(raw.owner ?? raw.eigandi),
    breeder: text(raw.breeder ?? raw.raektandi),
  };
}

/**
 * Fetch a breeding record for an IS registration number.
 *
 * Never throws. Returns `null` when the provider is not configured or when any
 * error / parse failure occurs; on failure it logs at warn level and lets the
 * caller degrade to empty breeding fields.
 *
 * @param {string} isNumber IS registration number.
 * @returns {Promise<BreedingRecord|null>}
 */
export async function getBreedingRecord(isNumber) {
  if (!isConfigured()) {
    return null;
  }

  const trimmed = String(isNumber ?? '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    const raw = await breedingClient.fetchBreedingRecord(trimmed);
    if (raw == null) {
      return null;
    }
    return toBreedingRecord(raw, trimmed);
  } catch (error) {
    console.warn(
      `Failed to fetch Worldfengur breeding record for ${trimmed}: ${error.message}`,
    );
    return null;
  }
}
