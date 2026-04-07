const MS_PER_DAY = 86_400_000;

export const TEST_SAVE_TIME_ZONE = "America/Los_Angeles";
export const TEST_SAVE_HOUR = 7;

type TimeZoneDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getTimeZoneDateParts(date: Date, timeZone: string): TimeZoneDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const lookup = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number.parseInt(lookup.year ?? "0", 10),
    month: Number.parseInt(lookup.month ?? "0", 10),
    day: Number.parseInt(lookup.day ?? "0", 10),
    hour: Number.parseInt(lookup.hour ?? "0", 10),
    minute: Number.parseInt(lookup.minute ?? "0", 10),
    second: Number.parseInt(lookup.second ?? "0", 10),
  };
}

function parseOffsetMinutes(value: string) {
  const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);

  if (!match) {
    return 0;
  }

  const [, sign, hoursText, minutesText] = match;
  const hours = Number.parseInt(hoursText, 10);
  const minutes = Number.parseInt(minutesText ?? "0", 10);
  const absoluteMinutes = hours * 60 + minutes;

  return sign === "-" ? -absoluteMinutes : absoluteMinutes;
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const offsetValue =
    formatter.formatToParts(date).find((part) => part.type === "timeZoneName")
      ?.value ?? "GMT+00:00";

  return parseOffsetMinutes(offsetValue);
}

function zonedTimeToUtc(
  parts: Pick<TimeZoneDateParts, "year" | "month" | "day"> & {
    hour: number;
    minute: number;
    second: number;
  },
  timeZone: string,
) {
  let utcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcMs), timeZone);
    const nextUtcMs =
      Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        0,
      ) -
      offsetMinutes * 60_000;

    if (nextUtcMs === utcMs) {
      break;
    }

    utcMs = nextUtcMs;
  }

  return new Date(utcMs);
}

export function getTomorrowPacificTestExportRunAt(now = new Date()) {
  const pacificNow = getTimeZoneDateParts(now, TEST_SAVE_TIME_ZONE);
  const pacificTodayUtcDate = new Date(
    Date.UTC(pacificNow.year, pacificNow.month - 1, pacificNow.day),
  );
  const pacificTomorrowUtcDate = new Date(
    pacificTodayUtcDate.getTime() + MS_PER_DAY,
  );

  return zonedTimeToUtc(
    {
      year: pacificTomorrowUtcDate.getUTCFullYear(),
      month: pacificTomorrowUtcDate.getUTCMonth() + 1,
      day: pacificTomorrowUtcDate.getUTCDate(),
      hour: TEST_SAVE_HOUR,
      minute: 0,
      second: 0,
    },
    TEST_SAVE_TIME_ZONE,
  );
}
