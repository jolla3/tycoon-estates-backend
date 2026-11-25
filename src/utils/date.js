// src/utils/date.js
//
// Section 17/19: ALL business date calculations use Africa/Nairobi. Never
// rely on the server's local timezone. Database timestamps stay UTC
// (Mongoose default); this module is the only place that should convert
// them for business logic or display.

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export const BUSINESS_TZ = 'Africa/Nairobi';

const DATE_ONLY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const dateUtil = {
  now: () => dayjs().tz(BUSINESS_TZ),
  today: () => dayjs().tz(BUSINESS_TZ).format('YYYY-MM-DD'),
  currentPeriod: () => dayjs().tz(BUSINESS_TZ).format('YYYY-MM'),
  periodOf: (date) => dayjs(date).tz(BUSINESS_TZ).format('YYYY-MM'),
  startOfMonth: (period) => dayjs.tz(`${period}-01`, BUSINESS_TZ).startOf('day'),
  endOfMonth: (period) => dayjs.tz(`${period}-01`, BUSINESS_TZ).endOf('month'),
  dueDateFor: (period, dueDay) => {
    const start = dayjs.tz(`${period}-01`, BUSINESS_TZ).startOf('day');
    const lastDay = start.endOf('month').date();
    const day = Math.min(Math.max(1, Number(dueDay) || 1), lastDay);
    return start.date(day).toDate();
  },
  dueDayWindowFor: (period, dueDay) => {
    const dueDate = dateUtil.dueDateFor(period, dueDay);
    if (!(dueDate instanceof Date) || Number.isNaN(dueDate.getTime())) return null;
    const start = dayjs(dueDate).tz(BUSINESS_TZ).startOf('day');
    const endExclusive = start.add(1, 'day').startOf('day');
    return { start: start.toDate(), endExclusive: endExclusive.toDate() };
  },
  format: (date, fmt = 'DD MMM YYYY, HH:mm') => dayjs(date).tz(BUSINESS_TZ).format(fmt),
  isSamePeriod: (dateA, dateB) => dateUtil.periodOf(dateA) === dateUtil.periodOf(dateB),

  /**
   * Parse a UI date-only string (YYYY-MM-DD) as an Africa/Nairobi calendar day.
   * Returns { start: Date, end: Date, noon: Date, dateStr, period } in UTC instants.
   * Never uses `new Date('YYYY-MM-DD')` (that is UTC midnight).
   */
  parseNairobiDateOnly(value) {
    const raw = String(value || '').trim();
    if (!DATE_ONLY.test(raw)) {
      return null;
    }
    const start = dayjs.tz(raw, BUSINESS_TZ).startOf('day');
    if (!start.isValid() || start.format('YYYY-MM-DD') !== raw) {
      return null; // e.g. 2026-02-31
    }
    const end = start.endOf('day');
    const noon = start.hour(12).minute(0).second(0).millisecond(0);
    return {
      dateStr: raw,
      period: start.format('YYYY-MM'),
      start: start.toDate(),
      end: end.toDate(),
      noon: noon.toDate(),
    };
  },
};
