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
    const num = Number(String(raw ?? '').trim().replace(',', '.'));
    // Skip speed/time values (> 10) — they are not judge marks.
    if (Number.isFinite(num) && num > 10) continue;
    marks.push(roundScore(raw));
  }
  return marks.slice(0, 5);
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

export function normalizeCurrent(apiResponse) {
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

  const judges = Array.isArray(apiResponse.einkunnir_domara)
    ? apiResponse.einkunnir_domara
    : [];
  const judgeScores = judgeMarksOnly(judges);

  const gaitScores = extractGaitScores(judges);
  const e1 = judgeScores[0] || '';
  const e2 = judgeScores[1] || '';
  const e3 = judgeScores[2] || '';
  const e4 = judgeScores[3] || '';
  const e5 = judgeScores[4] || '';
  const e6 = roundScore(getDisplayTotalScore(apiResponse), true);

  const liturRas =
    apiResponse.rodun_litur_numer != null && apiResponse.rodun_litur
      ? `${apiResponse.rodun_litur_numer} - ${apiResponse.rodun_litur}`
      : String(apiResponse.rodun_litur || '');

  return {
    Nr: String(apiResponse.vallarnumer || ''),
    Saeti: String(apiResponse.saeti || apiResponse.fmt_saeti || ''),
    Holl: String(apiResponse.holl || ''),
    Hond: String(apiResponse.hond || ''),
    Knapi: riderName,
    LiturRas: liturRas,
    colorHex: getColorHex(liturRas),
    FelagKnapa: String(apiResponse.adildarfelag_knapa || ''),
    Hestur: horseName,
    Litur: String(apiResponse.hross_litur || ''),
    Aldur: String(calculateAldur(apiResponse.faedingarnumer)),
    FelagEiganda: String(apiResponse.adildarfelag_eiganda || ''),
    Lid: String(
      apiResponse.lid || apiResponse.Lid || apiResponse.team_name || '',
    ),
    NafnBIG: riderName ? riderName.toUpperCase() : '',
    E1: e1,
    E2: e2,
    E3: e3,
    E4: e4,
    E5: e5,
    E6: e6,
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

export function normalizeLeaderboard(apiResponse) {
  if (!Array.isArray(apiResponse)) {
    return [];
  }

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

      const judges = Array.isArray(entry.einkunnir_domara)
        ? entry.einkunnir_domara
        : [];
      const judgeScores = judgeMarksOnly(judges);

      const gaitScores = extractGaitScores(judges);
      const e1 = judgeScores[0] || '';
      const e2 = judgeScores[1] || '';
      const e3 = judgeScores[2] || '';
      const e4 = judgeScores[3] || '';
      const e5 = judgeScores[4] || '';
      const e6 = roundScore(getDisplayTotalScore(entry), true);

      const liturRas =
        entry.rodun_litur_numer != null && entry.rodun_litur
          ? `${entry.rodun_litur_numer} - ${entry.rodun_litur}`
          : String(entry.rodun_litur || '');

      return {
        Nr: String(entry.vallarnumer || ''),
        Saeti: String(entry.saeti || entry.fmt_saeti || ''),
        Holl: String(entry.holl || ''),
        Hond: String(entry.hond || ''),
        Knapi: riderName,
        LiturRas: liturRas,
        colorHex: getColorHex(liturRas),
        FelagKnapa: String(entry.adildarfelag_knapa || ''),
        Hestur: horseName,
        Litur: String(entry.hross_litur || ''),
        Aldur: String(calculateAldur(entry.faedingarnumer)),
        FelagEiganda: String(entry.adildarfelag_eiganda || ''),
        Lid: String(entry.lid || entry.Lid || entry.team_name || ''),
        NafnBIG: riderName ? riderName.toUpperCase() : '',
        E1: e1,
        E2: e2,
        E3: e3,
        E4: e4,
        E5: e5,
        E6: e6,
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
