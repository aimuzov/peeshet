import { Invalid, type Rubric } from '#src/post.ts'

// В Москве нет перехода на летнее время с 2014 года, смещение постоянное.
const MSK = 3 * 3600
const DAY = 24 * 3600
const HOUR = 3600

export type Slots = {
	/** Час публикации по будням. */
	weekday: number
	/** Час публикации итогов недели в воскресенье. */
	weekly: number
}

export const DEFAULT_SLOTS: Slots = { weekday: 10, weekly: 19 }

/** Unix-время полуночи по Москве для дня, в который попадает `t`. */
export const mskDayStart = (t: number) =>
	Math.floor((t + MSK) / DAY) * DAY - MSK

export const todayAt = (now: number, hour: number) =>
	mskDayStart(now) + hour * HOUR
export const tomorrowAt = (now: number, hour: number) =>
	mskDayStart(now) + DAY + hour * HOUR

/** День недели по Москве: 0 — воскресенье. */
const mskWeekday = (t: number) => new Date((t + MSK) * 1000).getUTCDay()

/**
 * Первый будущий слот в день без запланированных постов. Итоги недели выходят в воскресенье,
 * остальные рубрики — по будням.
 */
export function nextFreeSlot(
	now: number,
	rubric: Rubric,
	taken: Set<number>,
	slots = DEFAULT_SLOTS,
): number {
	const busy = new Set([...taken].map(mskDayStart))

	for (let d = 0; d < 60; d++) {
		const day = mskDayStart(now) + d * DAY
		const weekday = mskWeekday(day)
		let slot: number | null = null

		if (rubric === 'неделя') {
			if (weekday === 0) slot = day + slots.weekly * HOUR
		} else if (weekday >= 1 && weekday <= 5) {
			slot = day + slots.weekday * HOUR
		}

		if (slot !== null && slot > now && !busy.has(day)) return slot
	}

	throw new Invalid('Нет свободного слота в ближайшие 60 дней.')
}

/** `22.10 12:00` по Москве. */
export function formatMsk(t: number): string {
	const d = new Date((t + MSK) * 1000)
	const pad = (n: number) => String(n).padStart(2, '0')

	return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
