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
  format: (date, fmt = 'DD MMM YYYY, HH:mm') => dayjs(date).tz(BUSINESS_TZ).format(fmt),
  isSamePeriod: (dateA, dateB) => dateUtil.periodOf(dateA) === dateUtil.periodOf(dateB),
};
