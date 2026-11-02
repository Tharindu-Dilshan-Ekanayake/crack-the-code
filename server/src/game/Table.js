const DATA = require('./data')

const LEN = DATA.codeLength
const T = DATA.timing
const CODE_RE = new RegExp(`^\\d{${LEN}}$`)
const ALL_HITS = '1'.repeat(LEN)

const randomInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1))
const randomCode = () => Array.from({ length: LEN }, () => randomInt(0, 9)).join('')
const isValidCode = (c) => typeof c === 'string' && CODE_RE.test(c)
/** "12_5_0": the digits cracked so far, blanks for the rest. */
const maskOf = (known) => known.map((d) => d ?? '_').join('')

/**
 * One two-seat table and the duel played at it.
 *
 * Phases:
 *   waiting   - zero or one player seated
 *   countdown - both seats filled, "Starting in 3..."
 *   choosing  - each player secretly picks a 6-digit code (repeats allowed)
 *   guessing  - players take turns entering a full code for the other's; the server
 *               marks each digit right or wrong. Right digits stay locked in, wrong
 *               ones are struck off for that slot
 *   ended     - result on screen; both players are stood up when it runs out
 *
 * The server holds both secrets. A client only ever learns its own code, and which
 * of the opponent's digits it has cracked (and which it has ruled out per slot).
 */
class Table {
  /**
   * @param {{ id: number, x: number, z: number }} def
   * @param {import('./GameRoom')} room
   * @param {object} state this table's synced TableState, for every client to see
   */
  constructor(def, room, state) {
    this.id = def.id
    this.x = def.x
    this.z = def.z
    this.room = room
    this.state = state
    /** @type {Array<import('./Session')|null>} */
    this.seats = [null, null]
    this.token = 0
    this.reset()
  }

  reset() {
    this.phase = 'waiting'
    this.endsAt = 0
    /** Each seat's code as a digit string, e.g. '127349'. */
    this.secrets = [null, null]
    /** known[i][p] = the digit seat i has cracked at slot p of seat (1-i)'s code, else null. */
    this.known = [Array(LEN).fill(null), Array(LEN).fill(null)]
    /** missed[i][p] = digits seat i has tried at slot p and been told are wrong, e.g. '38'. */
    this.missed = [Array(LEN).fill(''), Array(LEN).fill('')]
    this.guesses = [0, 0]
    /** history[i] = seat i's guesses so far: [{ code, hits }], hits like '110100' (1 = right digit). */
    this.history = [[], []]
    this.turn = 0
    /** Seat index of the winner once the duel has ended, else -1. */
    this.winner = -1
    /** Whether each seat has used its one Reveal Digit this match. */
    this.hintUsed = [false, false]
    this.timeouts = [0, 0]
    /** True between a guess and its answer, so a second guess can't sneak in. */
    this.pending = false
    // Invalidates any setTimeout scheduled for the previous match.
    this.token += 1
  }

  seatOf(session) {
    return this.seats.indexOf(session)
  }

  sit(session, now) {
    if (this.room.draining) return 'Server is updating, duels start again in a moment'
    if (this.phase !== 'waiting') return 'This table is already playing'
    const free = this.seats.indexOf(null)
    if (free < 0) return 'This table is full'

    this.seats[free] = session
    session.seat = { table: this, index: free }

    if (this.seats[0] && this.seats[1]) {
      this.phase = 'countdown'
      this.endsAt = now + T.countdown * 1000
    }
    this.sync(now)
    return null
  }

  /** A seated player stands up or disconnects. */
  leave(session, now) {
    const i = this.seatOf(session)
    if (i < 0) return
    const other = this.seats[1 - i]

    if (this.phase === 'guessing') {
      this.finish(1 - i, i, 'forfeit', now)
    } else if (this.phase === 'countdown' || this.phase === 'choosing') {
      other?.toast('Your opponent left the table')
    }

    this.unseat(i)
    if (this.phase !== 'ended') {
      // The remaining player (if any) keeps their seat and waits for someone new.
      this.reset()
      if (other) this.room.bubble(other, '')
    }
    this.sync(now)
  }

  unseat(i) {
    const session = this.seats[i]
    if (!session) return
    this.seats[i] = null
    session.seat = null
    session.send('match', { match: null })
  }

  pick(session, code, now) {
    const i = this.seatOf(session)
    if (i < 0 || this.phase !== 'choosing' || this.secrets[i] !== null) return
    if (!isValidCode(code)) return

    this.secrets[i] = code
    this.room.bubble(session, 'Ready ✅')
    if (this.secrets[1 - i] !== null) this.startGuessing(now)
    else this.sync(now)
  }

  guess(session, code, now) {
    const i = this.seatOf(session)
    if (i < 0 || this.phase !== 'guessing' || this.turn !== i || this.pending) return
    if (!isValidCode(code)) return
    // Cracked digits are locked in: a guess has to keep them.
    if (this.known[i].some((d, p) => d !== null && code[p] !== d)) return

    this.guesses[i] += 1
    this.timeouts[i] = 0
    this.pending = true
    this.room.bubble(session, `Is your code ${code}? 🤔`)
    // Both players see the guess land, then (after the suspense) each digit's answer.
    this.tell({ t: 'guessed', by: i, code })
    this.sync(now)

    const token = this.token
    // Room clock: cleared automatically if the room is disposed meanwhile.
    this.room.clock.setTimeout(() => {
      if (this.token !== token || this.phase !== 'guessing') return
      this.resolveGuess(i, code, Date.now())
    }, T.guessReveal * 1000)
  }

  resolveGuess(i, code, now) {
    const o = 1 - i
    const secret = this.secrets[o]
    let hits = ''
    for (let p = 0; p < LEN; p += 1) {
      if (code[p] === secret[p]) {
        hits += '1'
        this.known[i][p] = code[p]
      } else {
        hits += '0'
        if (!this.missed[i][p].includes(code[p])) this.missed[i][p] += code[p]
      }
    }
    this.history[i].push({ code, hits })
    this.tell({ t: 'answer', by: i, code, hits })
    if (hits === ALL_HITS) {
      this.finish(i, o, 'guessed', now)
      return
    }

    const right = hits.split('1').length - 1
    const mask = maskOf(this.known[i])
    this.room.bubble(this.seats[o], right === 0 ? `Nope! ❌ ${mask}` : `${right} right! 😬 ${mask}`)
    this.turn = o
    this.beginTurn(now)
  }

  /**
   * A duel event for both seated players, from each one's point of view: `mine`
   * is true for the player who made the guess.
   */
  tell({ t, by, ...rest }) {
    this.seats.forEach((s, i) => s?.send('duel', { t, mine: i === by, ...rest }))
  }

  /**
   * Paid power-ups. The only one is Reveal Digit ('hint'): it cracks one random
   * digit that is still unknown, once per player per match. Returns an error
   * string, or null on success.
   */
  power(session, kind, now) {
    const i = this.seatOf(session)
    if (i < 0 || this.phase !== 'guessing') return 'Power-ups work during guessing'
    const cost = DATA.powers[kind]
    if (cost === undefined) return 'Unknown power-up'
    if (this.hintUsed[i]) return 'Reveal Digit is once per match'
    if (session.profile.cash < cost) return `You need $${cost}`

    const open = []
    this.known[i].forEach((d, p) => d === null && open.push(p))
    if (open.length <= 1) return 'Only one digit left, you got this!'
    const p = open[randomInt(0, open.length - 1)]
    this.known[i][p] = this.secrets[1 - i][p]
    this.hintUsed[i] = true
    session.toast(`Digit ${p + 1} is ${this.known[i][p]} 🔓`)
    this.room.questEvent(session, 'hint', now)

    session.profile.cash -= cost
    session.pushProfile(now)
    this.sync(now)
    return null
  }

  startChoosing(now) {
    this.phase = 'choosing'
    this.endsAt = now + T.choose * 1000
    for (const s of this.seats) this.room.bubble(s, 'Choosing 🤔')
    this.sync(now)
  }

  startGuessing(now) {
    this.phase = 'guessing'
    this.turn = Math.random() < 0.5 ? 0 : 1
    this.beginTurn(now)
  }

  beginTurn(now) {
    this.pending = false
    this.endsAt = now + T.turn * 1000
    this.sync(now)
  }

  finish(w, l, reason, now) {
    this.phase = 'ended'
    this.endsAt = now + T.results * 1000
    this.pending = false
    this.winner = w

    const winner = this.seats[w]
    const loser = this.seats[l]
    let reward = 0

    if (winner) reward = this.room.recordWin(winner, this.guesses[w], now)
    let consolation = 0
    if (loser) consolation = this.room.recordLoss(loser, now, reason)
    // Quitting a duel under way (or disconnecting for good) pays the opponent.
    const forfeit = reason === 'forfeit' && loser && winner ? this.room.payForfeit(loser, winner, now) : 0
    if (loser) this.room.bubble(loser, reason === 'forfeit' ? 'I quit 🏳️' : 'NOOO! 💀')
    if (winner) this.room.bubble(winner, reason === 'forfeit' ? 'GG 👍' : 'Got it! 😎')

    this.room.broadcast('result', {
      table: this.id,
      winner: winner?.id ?? null,
      loser: loser?.id ?? null,
      codes: [...this.secrets],
      reward,
      consolation,
      /** Cash the quitter paid the winner (reason 'forfeit'). */
      forfeit,
      reason,
    })
    this.sync(now)
    // Round end: report leaderboard scores now rather than at the next batch.
    this.room.flushScores()

    // The loser falls apart at the table, then respawns back in the lobby while
    // the winner keeps dancing on their chair.
    const token = this.token
    this.room.clock.setTimeout(() => {
      if (this.token !== token || this.seats[l] !== loser || !loser) return
      this.unseat(l)
      loser.respawn()
      this.sync(Date.now())
    }, T.loserRespawn * 1000)
  }

  tick(now) {
    if (this.phase === 'waiting' || now < this.endsAt) return

    if (this.phase === 'countdown') {
      this.startChoosing(now)
    } else if (this.phase === 'choosing') {
      // Too slow to choose: the server chooses for you.
      this.secrets.forEach((s, i) => {
        if (s === null) {
          this.secrets[i] = randomCode()
          this.seats[i]?.toast(`Out of time! Your code is ${this.secrets[i]}`)
        }
      })
      this.startGuessing(now)
    } else if (this.phase === 'guessing' && !this.pending) {
      const slow = this.turn
      this.timeouts[slow] += 1
      if (this.timeouts[slow] >= 2) {
        this.finish(1 - slow, slow, 'afk', now)
      } else {
        this.seats[slow]?.toast('Too slow! Turn skipped')
        this.turn = 1 - slow
        this.beginTurn(now)
      }
    } else if (this.phase === 'ended') {
      this.unseat(0)
      this.unseat(1)
      this.reset()
      this.sync(now)
    }
  }

  privateState(i, now) {
    const o = 1 - i
    return {
      table: this.id,
      seat: i,
      phase: this.phase,
      endsInMs: Math.max(0, this.endsAt - now),
      myCode: this.secrets[i],
      /** Their code as far as this player has cracked it: a digit or null per slot. */
      known: [...this.known[i]],
      /** Digits ruled out at each slot of their code, e.g. ['38', '', ...]. */
      missed: [...this.missed[i]],
      /** Which slots of this player's own code the opponent has cracked. */
      theirKnown: this.known[o].map((d) => d !== null),
      myTurn: this.phase === 'guessing' && this.turn === i && !this.pending,
      theirTurn: this.phase === 'guessing' && this.turn === o,
      pending: this.pending,
      guesses: this.guesses[i],
      myHistory: this.history[i],
      theirHistory: this.history[o],
      won: this.phase === 'ended' && this.winner === i,
      hintUsed: this.hintUsed[i],
      opponent: this.seats[o]?.id ?? null,
      opponentReady: this.secrets[o] !== null,
    }
  }

  /**
   * Publishes the table: the public part through the synced state (Colyseus sends
   * only fields that changed), the private part to each seated player.
   */
  sync(now = Date.now()) {
    const st = this.state
    st.phase = this.phase
    st.seat0 = this.seats[0]?.id ?? ''
    st.seat1 = this.seats[1]?.id ?? ''
    st.chair0 = this.seats[0]?.profile.equippedChair ?? ''
    st.chair1 = this.seats[1]?.profile.equippedChair ?? ''
    st.turn = this.phase === 'guessing' ? (this.seats[this.turn]?.id ?? '') : ''
    st.winner = this.phase === 'ended' ? (this.seats[this.winner]?.id ?? '') : ''
    st.endsAt = this.phase === 'waiting' ? 0 : this.endsAt
    this.seats.forEach((s, i) => s?.send('match', { match: this.privateState(i, now) }))
  }
}

module.exports = Table
