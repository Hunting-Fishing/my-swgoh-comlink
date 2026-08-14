"use strict";

const GAC_DIVISIONS = new Map([
  [5, 5],
  [10, 4],
  [15, 3],
  [20, 2],
  [25, 1],
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstScalar(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return "";
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function displayDivision(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && GAC_DIVISIONS.has(numeric)) return GAC_DIVISIONS.get(numeric);
  return value ?? "";
}

function rosterOf(player) {
  if (!isRecord(player)) return [];
  for (const key of ["rosterUnit", "roster", "units", "unit"]) {
    if (Array.isArray(player[key]) && player[key].length) return player[key];
  }
  return [];
}

function preferredArray(record, keys) {
  for (const key of keys) {
    if (Array.isArray(record?.[key])) return record[key];
  }
  return [];
}

function equippedModCount(player) {
  return rosterOf(player).reduce((sum, unit) => {
    return sum + preferredArray(unit, ["equippedStatMod", "equippedStatMods"]).length;
  }, 0);
}

function purchasedAbilities(player) {
  const items = [];
  for (const unit of rosterOf(player)) {
    const baseId = firstText(unit?.definitionId, unit?.defId, unit?.baseId, unit?.id).split(":")[0];
    const entries = preferredArray(unit, ["purchasedAbilityId", "purchasedAbilityIds", "purchasedAbility"]);
    for (const entry of entries) {
      const abilityId = typeof entry === "string"
        ? entry
        : firstText(entry?.id, entry?.abilityId, entry?.definitionId);
      if (!abilityId) continue;
      items.push({ baseId, abilityId });
    }
  }
  return items;
}

function ratingRecord(player) {
  const rating = player?.playerRating;
  if (Array.isArray(rating)) return rating.find(isRecord) || {};
  return isRecord(rating) ? rating : {};
}

function gacRating(player) {
  const rating = ratingRecord(player);
  const skill = isRecord(rating.playerSkillRating) ? rating.playerSkillRating : {};
  const rawDivision = firstScalar(
    rating.division,
    rating.divisionId,
    skill.division,
    skill.divisionId,
    player?.gacDivision
  );
  return {
    skillRating: finiteNumber(
      skill.skillRating,
      rating.skillRating,
      player?.playerSkillRating?.skillRating,
      player?.gacSkillRating
    ),
    league: firstScalar(
      rating.league,
      rating.leagueId,
      skill.league,
      skill.leagueId,
      player?.gacLeague
    ),
    division: displayDivision(rawDivision),
    ...(rawDivision !== "" ? { divisionId: rawDivision } : {}),
  };
}

function normalizeProfileStats(player) {
  return asArray(player?.profileStat).map((stat, index) => {
    if (!isRecord(stat)) return { id: `stat-${index + 1}`, value: stat };
    const id = firstText(
      stat.id,
      stat.statId,
      stat.profileStatId,
      stat.nameKey,
      stat.key,
      `stat-${index + 1}`
    );
    const value = stat.value ?? stat.statValue ?? stat.currentValue ?? stat.count ?? stat.score ?? null;
    return {
      id,
      value,
      ...(firstText(stat.nameKey) ? { nameKey: firstText(stat.nameKey) } : {}),
    };
  });
}

function normalizeSeasonStatus(player) {
  const statuses = asArray(player?.seasonStatus)
    .filter(isRecord)
    .map((status) => {
      const rawDivision = status.division ?? "";
      return {
        seasonId: firstText(status.seasonId),
        eventInstanceId: firstText(status.eventInstanceId),
        league: firstScalar(status.league),
        division: displayDivision(rawDivision),
        ...(rawDivision !== "" ? { divisionId: rawDivision } : {}),
        seasonPoints: finiteNumber(status.seasonPoints),
        rank: finiteNumber(status.rank),
        joinTime: String(status.joinTime ?? ""),
        endTime: String(status.endTime ?? ""),
      };
    });

  return statuses.sort((left, right) => {
    const leftTime = Number(left.joinTime || left.endTime || 0);
    const rightTime = Number(right.joinTime || right.endTime || 0);
    return rightTime - leftTime;
  });
}

function selectedCosmetics(player) {
  const selectedTitle = isRecord(player?.selectedPlayerTitle) ? player.selectedPlayerTitle : {};
  const selectedPortrait = isRecord(player?.selectedPlayerPortrait) ? player.selectedPlayerPortrait : {};
  return {
    titleId: firstText(selectedTitle.id, selectedTitle.titleId, selectedTitle.definitionId),
    portraitId: firstText(selectedPortrait.id, selectedPortrait.portraitId, selectedPortrait.definitionId),
  };
}

function publicPlayerSummary(player) {
  const rating = gacRating(player);
  const purchased = purchasedAbilities(player);
  const profileStats = normalizeProfileStats(player);
  const seasons = normalizeSeasonStatus(player);
  const latestSeason = seasons[0] || {};
  const cosmetics = selectedCosmetics(player);
  const unlockedTitles = preferredArray(player, ["unlockedPlayerTitle", "unlockedTitles"]);
  const unlockedPortraits = preferredArray(player, ["unlockedPlayerPortrait", "unlockedPortraits"]);
  const league = rating.league !== "" ? rating.league : latestSeason.league ?? "";
  const division = rating.division !== "" ? rating.division : latestSeason.division ?? "";

  return {
    summary: {
      equippedMods: equippedModCount(player),
      purchasedAbilities: purchased.length,
      unlockedTitles: unlockedTitles.length,
      unlockedPortraits: unlockedPortraits.length,
    },
    competitive: {
      ...(rating.skillRating ? { gacSkillRating: rating.skillRating } : {}),
      ...(league !== "" ? { gacLeague: league } : {}),
      ...(division !== "" && division !== 0 ? { gacDivision: division } : {}),
    },
    profileStats,
    purchasedAbilities: purchased,
    seasonStatus: seasons,
    ...(cosmetics.titleId || cosmetics.portraitId ? { selectedCosmetics: cosmetics } : {}),
  };
}

module.exports = {
  GAC_DIVISIONS,
  displayDivision,
  equippedModCount,
  gacRating,
  normalizeProfileStats,
  normalizeSeasonStatus,
  publicPlayerSummary,
  purchasedAbilities,
  rosterOf,
  selectedCosmetics,
};
