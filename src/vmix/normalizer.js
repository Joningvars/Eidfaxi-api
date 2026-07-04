import {
  getClassTypePolicy,
  applyFieldMapping,
  formatDecimals,
  averageMarks,
  formatSpeedTime,
  scaleSpeedTime,
  positionColorName,
} from './class-type.js';

/**
 * The 3-color preliminary palette used when more than one entry is on course
 * or during a special preliminary. Takes precedence over the class-type palette
 * (Requirements 11.3, 11.4).
 */
const PRELIMINARY_PALETTE = ['red', 'yellow', 'green'];

/**
 * Resolve the rider club feeding the rider-primary `Lid` mapping. Today the
 * rider's registered club lives in `adildarfelag_knapa`; kept in one place so
 * the field-mapping call sites stay readable.
 *
 * @param {object} entry Sportfengur entry / current-competitor payload
 * @returns {string}
 */
function resolveRiderClub(entry) {
  return String(entry?.adildarfelag_knapa || '');
}

/**
 * Resolve the horse club feeding the competitor-horse `Lid` mapping (adult
 * quality classes). The exact Sportfengur field name is not yet confirmed, so
 * an ordered candidate list is used with the owner's club as the final
 * fallback (design: roster-enrichment horse-club sourcing / task 7.1). Emits
 * an empty string when no candidate is present.
 *
 * @param {object} entry Sportfengur entry / current-competitor payload
 * @returns {string}
 */
function resolveHorseClub(entry) {
  return String(
    entry?.adildarfelag_hross ||
      entry?.hross_adildarfelag ||
      entry?.adildarfelag_eiganda ||
      '',
  );
}

/**
 * Legacy `Lid` value used by the pre-Landsmót (default / Sport_Tolt) path. The
 * default path must remain byte-for-byte identical, so `Lid` keeps sourcing
 * from the team-name fields when no Class_Type context is supplied.
 *
 * @param {object} entry Sportfengur entry / current-competitor payload
 * @returns {string}
 */
function resolveLegacyLid(entry) {
  return String(entry?.lid || entry?.Lid || entry?.team_name || '');
}

function calculateAldur(faedingarnumer) {
  if (!faedingarnumer || typeof faedingarnumer !== 'string') return '';
  const match = faedingarnumer.match(/(\d{4})/);
  if (!match) return '';
  const year = Number(match[1]);
  if (
    !Number.isInteger(year) ||
    year < 1900 ||
    year > new Date().getFullYear()
  ) {
    return '';
  }
  return new Date().getFullYear() - year;
}

function roundScore(value, fixedTwoDecimals = false) {
  if (value === null || value === undefined || value === '') return '';

  const strValue = String(value).trim().replace(',', '.');
  if (strValue === '') return '';

  const num = Number(strValue);
  if (!Number.isFinite(num)) return '';

  const rounded = Math.round(num * 100) / 100;
  if (fixedTwoDecimals) {
    return rounded.toFixed(2);
  }
  const text = String(rounded);
  if (!text.includes('.')) {
    return `${text}.0`;
  }
  return text;
}

/**
 * Split a judge array into real judge marks and a speed/time value.
 *
 * Judge main marks (`domari_adaleinkunn`) are on a 0–10 scale. Skeið and
 * gæðingaskeið record a speed/time in one of the judge slots instead of a mark —
 * it shows up as a value greater than 10. We drop those out so they do not
 * pollute the E1–E5 judge columns; the remaining real marks fill E1..En.
 *
 * @param {Array<{domari_adaleinkunn?: any}>} judges
 * @returns {string[]} the real judge marks (max 5)
 */
function judgeMarksOnly(judges) {
  const marks = [];
  for (const judge of Array.isArray(judges) ? judges : []) {
    const raw = judge?.domari_adaleinkunn;
    const num = Number(
      String(raw ?? '')
        .trim()
        .replace(',', '.'),
    );
    // Skip speed/time values (> 10) — they are not judge marks.
    if (Number.isFinite(num) && num > 10) continue;
    marks.push(roundScore(raw));
  }
  return marks.slice(0, 5);
}

/**
 * Collect the raw (unformatted) real judge marks for the policy-driven path.
 *
 * Mirrors `judgeMarksOnly`'s speed/time filtering (values > 10 are a
 * skeið/gæðingaskeið time, not a judge mark) but returns the *raw* values so
 * the caller can format them with `formatDecimals(value, policy.judgeDecimals)`
 * and average them with `averageMarks(marks, policy.averaging)` at full
 * precision (avoids double-rounding through `roundScore`). Non-numeric / blank
 * entries are passed through unchanged; `formatDecimals`/`averageMarks` treat
 * them as unavailable.
 *
 * @param {Array<{domari_adaleinkunn?: any}>} judges
 * @returns {any[]} the raw real judge marks (max 5)
 */
function rawJudgeMarks(judges) {
  const marks = [];
  for (const judge of Array.isArray(judges) ? judges : []) {
    const raw = judge?.domari_adaleinkunn;
    const num = Number(
      String(raw ?? '')
        .trim()
        .replace(',', '.'),
    );
    // Skip speed/time values (> 10) — they are not judge marks.
    if (Number.isFinite(num) && num > 10) continue;
    marks.push(raw);
  }
  return marks.slice(0, 5);
}

/**
 * Split a gæðingaskeið judge array into the four real Judge_Marks and the
 * single Speed_Time. The Speed_Time is recorded in one of the judge slots as a
 * value greater than 10; the remaining slots hold the real 0–10 marks. Returns
 * the *raw* values so the caller can format marks with `formatDecimals` and the
 * time via `formatSpeedTime(scaleSpeedTime(...))` (Requirements 7.1–7.3).
 *
 * @param {Array<{domari_adaleinkunn?: any}>} judges
 * @returns {{ marks: any[], speed: any }} up to four raw marks + the raw speed
 *   (`null` when no speed value is present)
 */
function splitGaedingaskeid(judges) {
  const marks = [];
  let speed = null;
  for (const judge of Array.isArray(judges) ? judges : []) {
    const raw = judge?.domari_adaleinkunn;
    const num = Number(
      String(raw ?? '')
        .trim()
        .replace(',', '.'),
    );
    if (Number.isFinite(num) && num > 10) {
      // First speed value (> 10) fills the TIME slot; ignore any extras.
      if (speed === null) speed = raw;
      continue;
    }
    marks.push(raw);
  }
  return { marks: marks.slice(0, 4), speed };
}

/**
 * Return the first judge value that parses to a finite number > 10 — the
 * skeið / gæðingaskeið speed/time recorded in a judge slot — as its RAW value
 * (so the caller can format it via `formatSpeedTime(scaleSpeedTime(...))`).
 * Returns `null` when no such value is present (not a sprint). Mirrors the
 * comma-normalization parsing style used elsewhere in this file.
 *
 * @param {Array<{domari_adaleinkunn?: any}>} judges
 * @returns {any} the first raw value > 10, or `null` when none present
 */
function findSpeedTime(judges) {
  for (const judge of Array.isArray(judges) ? judges : []) {
    const raw = judge?.domari_adaleinkunn;
    const num = Number(
      String(raw ?? '')
        .trim()
        .replace(',', '.'),
    );
    if (Number.isFinite(num) && num > 10) return raw;
  }
  return null;
}

/**
 * Collect judges 1..5 verbatim (no speed filtering, no reordering) for the
 * B-úrslit real-score path. Returns the raw values so the caller can format
 * each present value at two decimals and emit an empty string for
 * missing/blank/non-numeric slots (Requirements 10.1, 10.2).
 *
 * @param {Array<{domari_adaleinkunn?: any}>} judges
 * @returns {any[]} up to five raw judge values in slot order
 */
function allJudgeMarks(judges) {
  const marks = [];
  for (const judge of Array.isArray(judges) ? judges : []) {
    marks.push(judge?.domari_adaleinkunn);
  }
  return marks.slice(0, 5);
}

/**
 * Extract the leading integer position from a Ras_Color value such as
 * `"1 - Rauður"`. Returns `NaN` when no leading integer is present so
 * `positionColorName` (a total function) emits an empty color name for absent /
 * malformed values (Requirement 11.5).
 *
 * @param {*} liturRas
 * @returns {number} the position integer, or NaN when unparseable
 */
function positionFromRasColor(liturRas) {
  const match = String(liturRas ?? '')
    .trim()
    .match(/^(\d+)/);
  return match ? Number(match[1]) : NaN;
}

/**
 * Compute the context-aware (Class_Type-driven) judge/score fields for a single
 * entry. Only called on the explicit-context path; the default / no-context
 * path is handled inline and stays byte-for-byte identical.
 *
 * Three sub-modes, in precedence order:
 *   1. B-úrslit (`context.competitionId === 3`): judges 1..5 map directly to
 *      slots E1..E5 with NO drop and NO speed filtering, each present value at
 *      two decimals, empty for missing/blank/non-numeric; E6 is the finals
 *      average (sum ÷ 5) at two decimals (Requirements 10.1–10.3, 9.5, 9.6).
 *   2. Gæðingaskeið (`policy.layout === 'gaedingaskeid'`): separate the single
 *      Speed_Time (value > 10) from the four real marks, emit ordered
 *      `D1, D2, D3, TIME, D5` + `Final`; marks at one decimal, TIME via
 *      `formatSpeedTime(scaleSpeedTime(raw))`, Final at two decimals; missing
 *      speed / mark → empty string (Requirements 7.1–7.8). The ordered values
 *      are mirrored onto E1..E6 and the named fields are returned in `extra`.
 *   3. Standard: E1..E5 via `formatDecimals(mark, policy.judgeDecimals)` and E6
 *      via `averageMarks(marks, policy.averaging)` (Requirements 5, 6).
 *
 * @param {Array} judges  the entry's `einkunnir_domara` array
 * @param {object} source the raw entry (for the Sportfengur display total)
 * @param {import('./class-type.js').ClassTypePolicy} policy
 * @param {object} context normalization context
 * @returns {{E1:string,E2:string,E3:string,E4:string,E5:string,E6:string,extra?:object}}
 */
function computeContextScores(judges, source, policy, context) {
  // 0. Sprint time rule (data-driven; takes precedence over BOTH the B-úrslit
  // branch and the gæðingaskeið layout branch). The 100/150/250 m sprints
  // record the time in a judge slot as a value > 10; because their
  // keppni_numer is 4/5/6… they never carry Gaedingaskeid_Class and may land
  // on the b-úrslit slot (competitionId 3). Regardless of slot/classType: when
  // a time value is present, the real judge marks (≤ 10) fill E1..E5 (one
  // decimal) and the time goes to E6 — NOT E4. The time is also exposed as a
  // named `TIME` field for templates that reference it.
  const timeRaw = findSpeedTime(judges);
  if (timeRaw !== null) {
    const sprintMarks = rawJudgeMarks(judges);
    const TIME = formatSpeedTime(scaleSpeedTime(timeRaw));
    return {
      E1: formatDecimals(sprintMarks[0], 1),
      E2: formatDecimals(sprintMarks[1], 1),
      E3: formatDecimals(sprintMarks[2], 1),
      E4: formatDecimals(sprintMarks[3], 1),
      E5: formatDecimals(sprintMarks[4], 1),
      E6: TIME,
      extra: { TIME },
    };
  }

  // 1. B-úrslit real judge scores (Requirement 10).
  if (context && context.competitionId === 3) {
    const marks = allJudgeMarks(judges);
    const e1 = formatDecimals(marks[0], 2);
    const e2 = formatDecimals(marks[1], 2);
    const e3 = formatDecimals(marks[2], 2);
    const e4 = formatDecimals(marks[3], 2);
    const e5 = formatDecimals(marks[4], 2);
    const avg = averageMarks(marks, 'sum5');
    const e6 = avg === null ? '' : formatDecimals(avg, policy.finalDecimals);
    return { E1: e1, E2: e2, E3: e3, E4: e4, E5: e5, E6: e6 };
  }

  // 2. Gæðingaskeið ordered output (Requirement 7).
  if (policy.layout === 'gaedingaskeid') {
    const { marks, speed } = splitGaedingaskeid(judges);
    const D1 = formatDecimals(marks[0], policy.judgeDecimals);
    const D2 = formatDecimals(marks[1], policy.judgeDecimals);
    const D3 = formatDecimals(marks[2], policy.judgeDecimals);
    const TIME = formatSpeedTime(scaleSpeedTime(speed));
    const D5 = formatDecimals(marks[3], policy.judgeDecimals);
    const Final = formatDecimals(
      getDisplayTotalScore(source),
      policy.finalDecimals,
    );
    return {
      E1: D1,
      E2: D2,
      E3: D3,
      E4: TIME,
      E5: D5,
      E6: Final,
      extra: { D1, D2, D3, TIME, D5, Final },
    };
  }

  // 3. Standard context path (Requirements 5, 6).
  const marks = rawJudgeMarks(judges);
  const e1 = formatDecimals(marks[0], policy.judgeDecimals);
  const e2 = formatDecimals(marks[1], policy.judgeDecimals);
  const e3 = formatDecimals(marks[2], policy.judgeDecimals);
  const e4 = formatDecimals(marks[3], policy.judgeDecimals);
  const e5 = formatDecimals(marks[4], policy.judgeDecimals);
  const avg = averageMarks(marks, policy.averaging);
  const e6 = avg === null ? '' : formatDecimals(avg, policy.finalDecimals);
  return { E1: e1, E2: e2, E3: e3, E4: e4, E5: e5, E6: e6 };
}

/**
 * Resolve the finishing/start-position color name for the context path.
 *
 * Palette precedence (Requirement 11): when `multipleOnCourse` or
 * `isSpecialPreliminary` is set the 3-color preliminary palette
 * `[red, yellow, green]` is used, overriding the class-type palette; otherwise
 * the policy's palette applies. The position is derived from the Ras_Color
 * value and mapped via the total `positionColorName` (empty for out-of-range /
 * invalid positions).
 *
 * @param {*} liturRas Ras_Color value (e.g. "1 - Rauður")
 * @param {import('./class-type.js').ClassTypePolicy} policy
 * @param {object} context normalization context
 * @returns {string} the color name, or '' when out of range / invalid
 */
function resolveRasLitur(liturRas, policy, context) {
  const palette =
    context && (context.multipleOnCourse || context.isSpecialPreliminary)
      ? PRELIMINARY_PALETTE
      : policy.colorPalette;
  return positionColorName(positionFromRasColor(liturRas), palette);
}

function averageForDisplay(scores) {
  if (!Array.isArray(scores) || scores.length === 0) return null;

  const numeric = scores.filter((n) => Number.isFinite(n));
  if (numeric.length === 0) return null;

  // SportFengur judging convention for 5 judges: drop highest + lowest.
  if (numeric.length === 5) {
    const sorted = [...numeric].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, 4);
    return trimmed.reduce((sum, n) => sum + n, 0) / trimmed.length;
  }

  return numeric.reduce((sum, n) => sum + n, 0) / numeric.length;
}

function getDisplayTotalScore(entry) {
  // In tie-break situations SportFengur provides 5-judge average here.
  // Guard against non-numeric truthy values (objects, arrays) that some
  // competition types return.
  const fiveDs = entry?.keppandi_einkunn_5_ds;
  if (fiveDs !== null && fiveDs !== undefined && fiveDs !== '') {
    const num = Number(String(fiveDs).replace(',', '.'));
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return entry?.keppandi_medaleinkunn;
}

function sanitizeGaitKey(gaitType) {
  return String(gaitType)
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[áàâä]/g, 'a')
    .replace(/[éèêë]/g, 'e')
    .replace(/[íìîï]/g, 'i')
    .replace(/[óòôö]/g, 'o')
    .replace(/[úùûü]/g, 'u')
    .replace(/[ýÿ]/g, 'y')
    .replace(/[ð]/g, 'd')
    .replace(/[þ]/g, 'th')
    .replace(/[æ]/g, 'ae');
}

const COLOR_HEX_BY_RAS_COLOR = {
  '1 - Rauður': '#FF0000',
  '2 - Gulur': '#FFFF00',
  '3 - Grænn': '#008000',
  '4 - Blár': '#0000FF',
  '5 - Hvítur': '#FFFFFF',
  '6 - Svartur': '#000000',
};

function getColorHex(liturRas) {
  return COLOR_HEX_BY_RAS_COLOR[String(liturRas || '').trim()] || '';
}

function extractGaitScores(judges) {
  const gaitScores = {
    adal: {},
  };

  if (!Array.isArray(judges) || judges.length === 0) {
    return gaitScores;
  }

  judges.slice(0, 5).forEach((judge, index) => {
    const mainScore = judge?.domari_adaleinkunn;
    if (mainScore !== null && mainScore !== undefined) {
      gaitScores.adal[`E${index + 1}`] = roundScore(mainScore);
    }
  });

  for (let i = 1; i <= 5; i++) {
    if (!gaitScores.adal[`E${i}`]) {
      gaitScores.adal[`E${i}`] = '';
    }
  }

  const adalScores = Object.values(gaitScores.adal).filter((s) => s !== '');
  if (adalScores.length > 0) {
    const avg = averageForDisplay(adalScores.map((s) => Number(s)));
    gaitScores.adal.E6 = avg == null ? '' : roundScore(avg, true);
  } else {
    gaitScores.adal.E6 = '';
  }

  const gaitMaps = {};
  const gaitTitles = {};

  judges.slice(0, 5).forEach((judge, judgeIndex) => {
    const breakdown = judge?.sundurlidun_einkunna;
    if (!Array.isArray(breakdown)) return;

    for (const item of breakdown) {
      const gaitType = item?.gangtegund;
      const score = item?.einkunn;

      if (!gaitType || score === null || score === undefined) continue;

      const gaitKey = sanitizeGaitKey(gaitType);

      if (!gaitMaps[gaitKey]) {
        gaitMaps[gaitKey] = new Map();
        gaitTitles[gaitKey] = gaitType;
      }
      gaitMaps[gaitKey].set(judgeIndex, roundScore(score));
    }
  });

  Object.keys(gaitMaps).forEach((gaitKey) => {
    const map = gaitMaps[gaitKey];
    const scores = [];
    gaitScores[gaitKey] = {
      _title: gaitTitles[gaitKey],
    };

    for (let i = 0; i < 5; i++) {
      if (map.has(i)) {
        gaitScores[gaitKey][`E${i + 1}`] = map.get(i);
        scores.push(Number(map.get(i)));
      } else {
        gaitScores[gaitKey][`E${i + 1}`] = '';
      }
    }

    if (scores.length > 0) {
      const avg = averageForDisplay(scores);
      gaitScores[gaitKey].E6 = avg == null ? '' : roundScore(avg, true);
    } else {
      gaitScores[gaitKey].E6 = '';
      delete gaitScores[gaitKey];
    }
  });

  return gaitScores;
}

export function normalizeCurrent(apiResponse, context = {}) {
  if (!apiResponse || typeof apiResponse !== 'object') {
    return {
      Nr: '',
      Saeti: '',
      Holl: '',
      Hond: '',
      Knapi: '',
      LiturRas: '',
      FelagKnapa: '',
      Hestur: '',
      Litur: '',
      Aldur: '',
      FelagEiganda: '',
      Lid: '',
      NafnBIG: '',
      E1: '',
      E2: '',
      E3: '',
      E4: '',
      E5: '',
      E6: '',
      adal: {
        E1: '',
        E2: '',
        E3: '',
        E4: '',
        E5: '',
        E6: '',
      },
      timestamp: new Date().toISOString(),
    };
  }

  const riderName = String(
    apiResponse.knapi_fullt_nafn ||
      apiResponse.knapi_fulltnafn ||
      apiResponse.knapi_nafn ||
      '',
  );
  const horseName = String(
    apiResponse.hross_fullt_nafn ||
      apiResponse.hross_fulltnafn ||
      apiResponse.hross_nafn ||
      '',
  );

  // Class_Type-driven field mapping (Requirements 2, 3, 4). The default /
  // no-context path resolves to the Sport_Tolt (rider-primary) policy, so
  // Knapi/Hestur are identical to the pre-Landsmót behavior. `Lid` keeps its
  // legacy team-name source unless an explicit Class_Type is supplied, so the
  // default path stays byte-for-byte identical (Requirement 1.7).
  const policy = getClassTypePolicy(context.classType);
  const mapping = applyFieldMapping(
    {
      riderName,
      horseName,
      riderClub: resolveRiderClub(apiResponse),
      horseClub: resolveHorseClub(apiResponse),
    },
    policy,
  );
  const hasClassContext = context != null && context.classType != null;
  const lid = hasClassContext ? mapping.Lid : resolveLegacyLid(apiResponse);

  const judges = Array.isArray(apiResponse.einkunnir_domara)
    ? apiResponse.einkunnir_domara
    : [];

  const gaitScores = extractGaitScores(judges);

  // Judge marks + Final_Score. The default / no-context path keeps the exact
  // pre-Landsmót formatting (roundScore: judges up to 2 decimals, Final at 2
  // decimals sourced from Sportfengur's display total). When an explicit
  // Class_Type context is supplied, format E1..E5 with `policy.judgeDecimals`
  // and compute the Final_Score via `averageMarks(marks, policy.averaging)`
  // formatted at `policy.finalDecimals` — emitting empty when preconditions are
  // unmet (fewer than five numeric marks, or averaging === null)
  // (Requirements 5.1–5.5, 6.1–6.4, 9.5, 9.6).
  let e1, e2, e3, e4, e5, e6;
  let gaedingaFields = null;
  if (hasClassContext) {
    const scores = computeContextScores(judges, apiResponse, policy, context);
    e1 = scores.E1;
    e2 = scores.E2;
    e3 = scores.E3;
    e4 = scores.E4;
    e5 = scores.E5;
    e6 = scores.E6;
    gaedingaFields = scores.extra || null;
  } else {
    const judgeScores = judgeMarksOnly(judges);
    e1 = judgeScores[0] || '';
    e2 = judgeScores[1] || '';
    e3 = judgeScores[2] || '';
    e4 = judgeScores[3] || '';
    e5 = judgeScores[4] || '';
    e6 = roundScore(getDisplayTotalScore(apiResponse), true);
  }

  const liturRas =
    apiResponse.rodun_litur_numer != null && apiResponse.rodun_litur
      ? `${apiResponse.rodun_litur_numer} - ${apiResponse.rodun_litur}`
      : String(apiResponse.rodun_litur || '');

  return {
    Nr: String(apiResponse.vallarnumer || ''),
    Saeti: String(apiResponse.saeti || apiResponse.fmt_saeti || ''),
    Holl: String(apiResponse.holl || ''),
    Hond: String(apiResponse.hond || ''),
    Knapi: mapping.Knapi,
    LiturRas: liturRas,
    colorHex: getColorHex(liturRas),
    ...(hasClassContext
      ? { RasLitur: resolveRasLitur(liturRas, policy, context) }
      : {}),
    FelagKnapa: String(apiResponse.adildarfelag_knapa || ''),
    Hestur: mapping.Hestur,
    Litur: String(apiResponse.hross_litur || ''),
    Aldur: String(calculateAldur(apiResponse.faedingarnumer)),
    FelagEiganda: String(apiResponse.adildarfelag_eiganda || ''),
    Lid: lid,
    NafnBIG: riderName ? riderName.toUpperCase() : '',
    E1: e1,
    E2: e2,
    E3: e3,
    E4: e4,
    E5: e5,
    E6: e6,
    ...(gaedingaFields || {}),
    ...gaitScores,
    adal: {
      E1: e1,
      E2: e2,
      E3: e3,
      E4: e4,
      E5: e5,
      E6: e6,
    },
    timestamp: new Date().toISOString(),
  };
}

export function normalizeLeaderboard(apiResponse, context = {}) {
  if (!Array.isArray(apiResponse)) {
    return [];
  }

  const policy = getClassTypePolicy(context.classType);
  const hasClassContext = context != null && context.classType != null;

  return apiResponse
    .filter((entry) => entry != null)
    .map((entry) => {
      const riderName = String(
        entry.knapi_fullt_nafn ||
          entry.knapi_fulltnafn ||
          entry.knapi_nafn ||
          '',
      );
      const horseName = String(
        entry.hross_fullt_nafn ||
          entry.hross_fulltnafn ||
          entry.hross_nafn ||
          '',
      );

      // Class_Type-driven field mapping (Requirements 2, 3, 4). Default /
      // no-context resolves to the rider-primary policy so Knapi/Hestur match
      // the pre-Landsmót behavior; `Lid` keeps its legacy team-name source
      // unless an explicit Class_Type is supplied (Requirement 1.7).
      const mapping = applyFieldMapping(
        {
          riderName,
          horseName,
          riderClub: resolveRiderClub(entry),
          horseClub: resolveHorseClub(entry),
        },
        policy,
      );
      const lid = hasClassContext ? mapping.Lid : resolveLegacyLid(entry);

      const judges = Array.isArray(entry.einkunnir_domara)
        ? entry.einkunnir_domara
        : [];

      const gaitScores = extractGaitScores(judges);

      // Judge marks + Final_Score. Default / no-context path keeps the exact
      // pre-Landsmót formatting; an explicit Class_Type context formats E1..E5
      // with `policy.judgeDecimals` and computes the Final_Score via
      // `averageMarks(marks, policy.averaging)` at `policy.finalDecimals`,
      // emitting empty when preconditions are unmet (Requirements 5.1–5.5,
      // 6.1–6.4, 9.5, 9.6).
      let e1, e2, e3, e4, e5, e6;
      let gaedingaFields = null;
      if (hasClassContext) {
        const scores = computeContextScores(judges, entry, policy, context);
        e1 = scores.E1;
        e2 = scores.E2;
        e3 = scores.E3;
        e4 = scores.E4;
        e5 = scores.E5;
        e6 = scores.E6;
        gaedingaFields = scores.extra || null;
      } else {
        const judgeScores = judgeMarksOnly(judges);
        e1 = judgeScores[0] || '';
        e2 = judgeScores[1] || '';
        e3 = judgeScores[2] || '';
        e4 = judgeScores[3] || '';
        e5 = judgeScores[4] || '';
        e6 = roundScore(getDisplayTotalScore(entry), true);
      }

      const liturRas =
        entry.rodun_litur_numer != null && entry.rodun_litur
          ? `${entry.rodun_litur_numer} - ${entry.rodun_litur}`
          : String(entry.rodun_litur || '');

      return {
        Nr: String(entry.vallarnumer || ''),
        Saeti: String(entry.saeti || entry.fmt_saeti || ''),
        Holl: String(entry.holl || ''),
        Hond: String(entry.hond || ''),
        Knapi: mapping.Knapi,
        LiturRas: liturRas,
        colorHex: getColorHex(liturRas),
        ...(hasClassContext
          ? { RasLitur: resolveRasLitur(liturRas, policy, context) }
          : {}),
        FelagKnapa: String(entry.adildarfelag_knapa || ''),
        Hestur: mapping.Hestur,
        Litur: String(entry.hross_litur || ''),
        Aldur: String(calculateAldur(entry.faedingarnumer)),
        FelagEiganda: String(entry.adildarfelag_eiganda || ''),
        Lid: lid,
        NafnBIG: riderName ? riderName.toUpperCase() : '',
        E1: e1,
        E2: e2,
        E3: e3,
        E4: e4,
        E5: e5,
        E6: e6,
        ...(gaedingaFields || {}),
        ...gaitScores,
        adal: {
          E1: e1,
          E2: e2,
          E3: e3,
          E4: e4,
          E5: e5,
          E6: e6,
        },
      };
    })
    .sort((a, b) => {
      const rankA = Number(a.Saeti) || 999;
      const rankB = Number(b.Saeti) || 999;
      return rankA - rankB;
    });
}

export function leaderboardToCsv(leaderboard) {
  const baseHeaders = [
    'Nr',
    'Saeti',
    'Holl',
    'Hond',
    'Knapi',
    'LiturRas',
    'colorHex',
    'FelagKnapa',
    'Hestur',
    'Litur',
    'Aldur',
    'FelagEiganda',
    'Lid',
    'NafnBIG',
    'E1',
    'E2',
    'E3',
    'E4',
    'E5',
    'E6',
    'adalE1',
    'adalE2',
    'adalE3',
    'adalE4',
    'adalE5',
    'adalE6',
  ];

  if (!Array.isArray(leaderboard) || leaderboard.length === 0) {
    return baseHeaders.join(',') + '\n';
  }

  const excludedKeys = new Set([
    'Nr',
    'Saeti',
    'Holl',
    'Hond',
    'Knapi',
    'LiturRas',
    'colorHex',
    'FelagKnapa',
    'Hestur',
    'Litur',
    'Aldur',
    'FelagEiganda',
    'Lid',
    'NafnBIG',
    'E1',
    'E2',
    'E3',
    'E4',
    'E5',
    'E6',
    'adal',
    'timestamp',
  ]);

  const gaitKeys = new Set();
  for (const entry of leaderboard) {
    for (const [key, value] of Object.entries(entry || {})) {
      if (excludedKeys.has(key)) continue;
      if (value && typeof value === 'object') {
        gaitKeys.add(key);
      }
    }
  }

  const priority = [
    'tolt_frjals_hradi',
    'haegt_tolt',
    'tolt_med_slakan_taum',
    'brokk',
    'skeid',
    'flugskeid',
    'stokk',
  ];
  const sortedGaitKeys = [...gaitKeys].sort((a, b) => {
    const ai = priority.indexOf(a);
    const bi = priority.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  const gaitHeaders = [];
  for (const key of sortedGaitKeys) {
    gaitHeaders.push(
      `${key}E1`,
      `${key}E2`,
      `${key}E3`,
      `${key}E4`,
      `${key}E5`,
      `${key}E6`,
    );
  }

  const headers = [...baseHeaders, ...gaitHeaders];

  const rows = leaderboard.map((entry) => {
    const baseValues = [
      entry.Nr || '',
      entry.Saeti || '',
      entry.Holl || '',
      entry.Hond || '',
      escapeCsvField(entry.Knapi || ''),
      escapeCsvField(entry.LiturRas || ''),
      entry.colorHex || '',
      escapeCsvField(entry.FelagKnapa || ''),
      escapeCsvField(entry.Hestur || ''),
      escapeCsvField(entry.Litur || ''),
      entry.Aldur || '',
      escapeCsvField(entry.FelagEiganda || ''),
      entry.Lid || '',
      escapeCsvField(entry.NafnBIG || ''),
      entry.E1 || '',
      entry.E2 || '',
      entry.E3 || '',
      entry.E4 || '',
      entry.E5 || '',
      entry.E6 || '',
      entry?.adal?.E1 || '',
      entry?.adal?.E2 || '',
      entry?.adal?.E3 || '',
      entry?.adal?.E4 || '',
      entry?.adal?.E5 || '',
      entry?.adal?.E6 || '',
    ];

    const gaitValues = [];
    for (const key of sortedGaitKeys) {
      gaitValues.push(
        entry?.[key]?.E1 || '',
        entry?.[key]?.E2 || '',
        entry?.[key]?.E3 || '',
        entry?.[key]?.E4 || '',
        entry?.[key]?.E5 || '',
        entry?.[key]?.E6 || '',
      );
    }

    return [...baseValues, ...gaitValues].join(',');
  });

  return headers.join(',') + '\n' + rows.join('\n') + '\n';
}

function escapeCsvField(field) {
  const str = String(field);

  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}
