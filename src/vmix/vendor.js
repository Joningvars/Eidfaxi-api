
import { apiGetWithRetry } from '../sportfengur.js';
import { SPORTFENGUR_LOCALE } from '../config.js';
import { log } from '../logger.js';
import { enrichEntriesWithTeam } from '../roster-enrichment.js';

const startingListCache = new Map();

export async function fetchCurrentRider(eventId, classId, competitionId) {
  const data = await apiGetWithRetry(
    `/${SPORTFENGUR_LOCALE}/test/results/${classId}/${competitionId}`,
  );

  if (Array.isArray(data?.res) && data.res.length > 0) {
    const sorted = [...data.res].sort((a, b) => {
      const rankA = Number(a.saeti || a.fmt_saeti) || 999;
      const rankB = Number(b.saeti || b.fmt_saeti) || 999;
      return rankA - rankB;
    });
    const enriched = await enrichEntriesWithTeam([sorted[0]], eventId);
    return enriched[0] || sorted[0];
  }

  return {};
}

async function fetchStartingList(classId, competitionId, forceRefresh = false) {
  const cacheKey = `${classId}-${competitionId}`;

  if (!forceRefresh && startingListCache.has(cacheKey)) {
    const cached = startingListCache.get(cacheKey);
    log.vmix.cached(cached.data.length);
    return cached.data;
  }

  const startingListData = await apiGetWithRetry(
    `/${SPORTFENGUR_LOCALE}/startinglist/${classId}/${competitionId}`,
  );
  const startingList = Array.isArray(startingListData?.raslisti)
    ? startingListData.raslisti
    : [];

  startingListCache.set(cacheKey, {
    data: startingList,
    timestamp: Date.now(),
  });

  return startingList;
}

async function fetchResults(classId, competitionId) {
  const resultsData = await apiGetWithRetry(
    `/${SPORTFENGUR_LOCALE}/test/results/${classId}/${competitionId}`,
  );
  const scores = Array.isArray(resultsData?.einkunnir)
    ? resultsData.einkunnir
    : [];

  return scores;
}

export function invalidateStartingListCache(classId, competitionId) {
  const cacheKey = `${classId}-${competitionId}`;
  if (startingListCache.has(cacheKey)) {
    startingListCache.delete(cacheKey);
    log.vmix.cacheInvalidated(cacheKey);
  }
}

export function clearStartingListCache() {
  startingListCache.clear();
}

export async function fetchLeaderboard(
  eventId,
  classId,
  competitionId,
  forceRefresh = false,
) {
  try {
    const startingList = await fetchStartingList(
      classId,
      competitionId,
      forceRefresh,
    );

    const scores = await fetchResults(classId, competitionId);

    log.vmix.fetched(startingList.length, scores.length);

    const scoresByKeppandi = new Map();
    for (const score of scores) {
      if (score.keppandi_numer != null) {
        scoresByKeppandi.set(score.keppandi_numer, score);
      }
    }

    const combined = startingList.map((rider) => {
      const score = scoresByKeppandi.get(rider.keppandi_numer);
      return {
        ...rider,
        einkunnir_domara: score?.einkunnir_domara || [],
        keppandi_medaleinkunn: score?.keppandi_medaleinkunn,
        keppandi_einkunn_5_ds: score?.keppandi_einkunn_5_ds,
        saeti: score?.saeti,
      };
    });

    return enrichEntriesWithTeam(combined, eventId);
  } catch (error) {
    log.error('vMix vendor fetchLeaderboard', error);
    throw error;
  }
}
