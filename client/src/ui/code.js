import { DATA } from '../game/layout'

/** Digits in a secret code. */
export const CODE_LENGTH = DATA.codeLength

/** Delay between one revealed tile flipping and the next (the flip sound follows it). */
export const FLIP_STEP_MS = 140

/** How long a whole guess takes to flip over, start to finish. */
export const FLIP_TOTAL_MS = FLIP_STEP_MS * (CODE_LENGTH - 1) + 450

/** Number of right digits in a hits string like '110100'. */
export const countHits = (hits) => (hits ? hits.split('1').length - 1 : 0)

export const isCracked = (hits) => countHits(hits) === CODE_LENGTH
