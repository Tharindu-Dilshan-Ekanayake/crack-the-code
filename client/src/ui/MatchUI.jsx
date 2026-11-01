import { useEffect, useRef, useState } from 'react'

import { sfx } from '../audio/sfx'
import { DATA, emoteById, titleById } from '../game/layout'
import { useSettings } from '../game/quality'
import { useGame } from '../net/gameStore'
import { bubbles } from '../net/liveState'
import { send } from '../net/api'
import { CODE_LENGTH, countHits, FLIP_STEP_MS, FLIP_TOTAL_MS, isCracked } from './code'
import { money, useNow } from './format'

const SLOTS = Array.from({ length: CODE_LENGTH }, (_, i) => i)
const NO_LOCKS = Array(CODE_LENGTH).fill(null)
/** Phone-style keypad: 1-9, then delete / 0 / enter. */
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok']

const TILE = { ask: '#ffd92e', hit: '#22c55e', miss: '#e5484d' }

const secondsLeft = (endsAt, now) => Math.max(0, Math.ceil((endsAt - now) / 1000))
const crackedCount = (known) => (known ? known.filter((d) => d != null && d !== false).length : 0)

/** Big centre text (countdown, result), below the VS bar and above the players' heads. */
function Banner({ children, className = '' }) {
  return (
    <div className={`pointer-events-none absolute left-1/2 top-[30%] z-30 w-[92vw] -translate-x-1/2 text-center ${className}`}>
      {children}
    </div>
  )
}

function LeaveButton({ label = 'Leave', forfeit = false }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (forfeit && !window.confirm('Leaving now counts as a loss. Leave anyway?')) return
        sfx.click()
        send({ t: 'leave' })
      }}
      className="btn-3d press pointer-events-auto bg-gradient-to-b from-[#ff5a5a] to-[#d81f1f] px-4 py-1.5 text-base font-bold text-white"
    >
      <span className="stroke-thin">{label}</span>
    </button>
  )
}

function PowerButton({ icon, label, price, disabled, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="btn-3d press flex flex-1 items-center justify-center gap-2 bg-gradient-to-b from-[#4fd8ff] to-[#2a7bff] px-2 py-1.5 text-white disabled:opacity-45"
    >
      <span className="text-2xl leading-none">{icon}</span>
      <span className="flex flex-col items-start leading-tight">
        <span className="stroke-thin text-sm font-bold">{label}</span>
        <span className="stroke-thin text-xs font-bold text-[#c8ffc8]">{money(price)}</span>
      </span>
    </button>
  )
}

/**
 * A guessed code turning over tile by tile. While the answer is pending the tiles
 * bob in yellow (with the drum roll); then each flips to green (right digit) or
 * red (wrong), left to right. A cracked code finishes with a wave of hops.
 */
function FlipTiles({ code, hits }) {
  const cracked = isCracked(hits)
  const afterFlips = FLIP_TOTAL_MS - 30
  return (
    <div className="flex gap-1.5">
      {SLOTS.map((p) => {
        const hit = hits?.[p] === '1'
        const flipDelay = p * FLIP_STEP_MS
        // The outer box hops / shudders; the inner tile flips. Both animate transform,
        // so they can't share an element.
        const wrap = !hits ? '' : cracked ? 'tile-hop' : hit ? '' : 'tile-shudder'
        const wrapDelay = cracked ? afterFlips + p * 70 : flipDelay + 420
        return (
          <div key={p} className={wrap} style={wrap ? { animationDelay: `${wrapDelay}ms` } : undefined}>
            <div
              key={hits ? 'answered' : 'asked'}
              className={`btn-3d studs flex h-12 w-10 items-center justify-center sm:h-14 sm:w-11 ${
                hits ? 'tile-flip' : 'reveal-pulse'
              }`}
              style={
                hits
                  ? { '--from': TILE.ask, '--to': hit ? TILE.hit : TILE.miss, animationDelay: `${flipDelay}ms` }
                  : { backgroundColor: TILE.ask, animationDelay: `${p * 70}ms` }
              }
            >
              <span className="stroke-text text-[1.9rem] font-bold leading-none text-white">{code[p]}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The guess being answered, in the sky under the VS bar: "You guessed" over the
 * six tiles, then the verdict slamming in once the last tile has turned. Both
 * players see it, each from their own side.
 */
function RevealCard({ reveal }) {
  const right = countHits(reveal.hits)
  const cracked = isCracked(reveal.hits)
  let badge = null
  let detail
  if (!reveal.hits) {
    detail = reveal.mine ? 'Checking every digit…' : 'Is it your code?'
  } else if (cracked) {
    badge = { text: 'CRACKED! 🔓', bg: 'from-[#fff15c] to-[#ffb800]' }
    detail = reveal.mine ? 'You cracked their code!' : 'They cracked your code!'
  } else if (right === 0) {
    badge = { text: 'NOPE! ❌', bg: 'from-[#ff7a7a] to-[#d81f1f]' }
    detail = reveal.mine ? 'No digits right' : 'They got nothing right'
  } else {
    badge = { text: `${right} RIGHT ✅`, bg: 'from-[#5dff7a] to-[#18b84a]' }
    detail = reveal.mine ? `${right} of ${CODE_LENGTH} digits right` : `They got ${right} of ${CODE_LENGTH} right`
  }

  return (
    <div className="reveal-pos pointer-events-none absolute left-1/2 z-40 -translate-x-1/2">
      <div className="ui-panel pop-in flex flex-col items-center gap-2 px-3 py-2">
        <div className="stroke-thin whitespace-nowrap text-sm font-bold text-white/90">
          {reveal.mine ? 'You guessed' : 'They guessed'}
        </div>
        <FlipTiles code={reveal.code} hits={reveal.hits} />
        <div className="flex min-h-[2.6rem] flex-col items-center justify-center gap-1">
          {badge ? (
            <div
              key={badge.text}
              className={`slam btn-3d bg-gradient-to-b px-4 py-0.5 ${badge.bg}`}
              style={{ animationDelay: `${FLIP_TOTAL_MS}ms`, animationFillMode: 'both' }}
            >
              <span className="stroke-text whitespace-nowrap text-[1.6rem] font-bold leading-none text-white">{badge.text}</span>
            </div>
          ) : (
            <div className="stroke-text text-[1.6rem] font-bold leading-none text-white">🥁 …</div>
          )}
          <div
            key={detail}
            className="pop-in stroke-thin text-center text-sm font-bold text-white"
            style={badge ? { animationDelay: `${FLIP_TOTAL_MS}ms`, animationFillMode: 'both' } : undefined}
          >
            {detail}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A small row of digit tiles. `marks[p]` colours each one: 'hit' green, 'miss' red,
 * anything else plain.
 */
function MiniCode({ code, marks }) {
  return (
    <span className="inline-flex gap-[3px]">
      {SLOTS.map((p) => {
        const mark = marks?.[p]
        const bg = mark === 'hit' ? 'bg-[#22c55e]' : mark === 'miss' ? 'bg-[#c83a3f]' : 'bg-[#3a4255]'
        return (
          <span
            key={p}
            className={`flex h-6 w-5 items-center justify-center rounded-md border-2 border-black/70 text-sm font-bold text-white ${bg}`}
          >
            <span className="stroke-thin">{code?.[p] ?? '?'}</span>
          </span>
        )
      })}
    </span>
  )
}

const marksOf = (hits) => SLOTS.map((p) => (hits[p] === '1' ? 'hit' : 'miss'))

/** The last few guesses, oldest first, each digit green or red. */
function GuessHistory({ label, history, max = 3 }) {
  if (!history?.length) return null
  const shown = history.slice(-max)
  const first = history.length - shown.length
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="stroke-thin text-xs font-bold text-white/80">{label}</span>
      {shown.map((g, i) => (
        <div key={first + i} className="flex items-center gap-1.5">
          <span className="w-5 text-right text-xs font-bold text-white/50">#{first + i + 1}</span>
          <MiniCode code={g.code} marks={marksOf(g.hits)} />
        </div>
      ))}
    </div>
  )
}

/** Six little lights: how much of a code has been cracked. */
function CrackMeter({ cracked, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-[3px] ${className}`}>
      <span className="mr-0.5 text-[0.7rem] leading-none">🔓</span>
      {SLOTS.map((p) => (
        <span
          key={p}
          className={`size-2 rounded-full border border-black/70 ${p < cracked ? 'bg-[#3dff78] shadow-[0_0_4px_#3dff78]' : 'bg-black/40'}`}
        />
      ))}
    </span>
  )
}

/** What a duelist last said (an emote, "Is your code 123456? 🤔", "2 right! 😬 1_____"), while it lasts. */
function speechOf(id, now) {
  const b = id ? bubbles.get(id) : null
  return b && b.text && b.until > now ? b.text : null
}

/** One side of the VS bar: title, name, level/streak, code progress, and a speech bubble underneath. */
function DuelistCard({ player, isSelf, active, cracked, speech, align }) {
  const title = titleById(player?.title)
  const badges = [`Lv ${player?.level || 1}`, player?.streak > 0 ? `🔥 ${player.streak}` : ''].filter(Boolean).join('  ')
  return (
    <div className={`flex min-w-0 flex-1 flex-col gap-1.5 ${align === 'left' ? 'items-start' : 'items-end'}`}>
      <div
        className={`ui-panel flex w-full min-w-0 flex-col px-2.5 py-1 ${
          align === 'left' ? 'items-start text-left' : 'items-end text-right'
        } ${active ? 'turn-ring' : ''}`}
      >
        {title && (
          <span
            className={`max-w-full truncate text-[0.65rem] font-bold leading-tight ${title.rainbow ? 'rainbow-text' : ''}`}
            style={title.rainbow ? undefined : { color: title.color }}
          >
            {title.name}
          </span>
        )}
        <span className="stroke-thin flex max-w-full items-center gap-1 text-base font-bold leading-tight text-white">
          <span className="truncate">{player?.name || '…'}</span>
          {isSelf && <span className="shrink-0 rounded bg-[#2a6bff] px-1 text-[0.6rem]">YOU</span>}
        </span>
        <span className="text-[0.7rem] font-bold leading-tight text-[#ffd23d]">{badges}</span>
        {cracked != null && <CrackMeter cracked={cracked} className="mt-0.5" />}
      </div>
      {speech && (
        <div
          key={speech}
          className={`speech pop-in max-w-full rounded-xl border-2 border-black/70 bg-white px-2 py-0.5 text-sm font-bold leading-snug text-[#1d2433] ${
            align === 'left' ? 'speech-left' : 'speech-right'
          }`}
        >
          {speech}
        </div>
      )}
    </div>
  )
}

/**
 * Top of the screen during a duel: opponent | timer + whose turn | you. The sides
 * match where each player sits on screen (seat 0 is on the right of the duel camera),
 * and what each one says shows under their card instead of over their heads. Each
 * card's lights show how much of the OTHER player's code that duelist has cracked.
 */
function DuelBar({ match, now }) {
  const selfId = useGame((s) => s.selfId)
  const profile = useGame((s) => s.profile)
  const them = useGame((s) => (match.opponent ? s.players[match.opponent] : null))
  const self = {
    name: profile?.name || 'You',
    level: profile?.level,
    streak: profile?.streak,
    title: profile?.equippedTitle,
  }

  const left = secondsLeft(match.endsAt, now)
  const guessing = match.phase === 'guessing'
  let status
  if (match.phase === 'countdown') status = 'GET READY'
  else if (match.phase === 'choosing') status = match.myCode == null ? 'SET YOUR CODE' : 'WAITING…'
  else if (match.myTurn) status = 'YOUR TURN'
  else if (match.pending) status = 'CHECKING…'
  else status = 'THEIR TURN'

  const myCard = (
    <DuelistCard
      key="me"
      player={self}
      isSelf
      active={match.myTurn}
      cracked={guessing ? crackedCount(match.known) : null}
      speech={speechOf(selfId, now)}
      align={match.seat === 0 ? 'right' : 'left'}
    />
  )
  const theirCard = (
    <DuelistCard
      key="them"
      player={them}
      active={match.theirTurn}
      cracked={guessing ? crackedCount(match.theirKnown) : null}
      speech={speechOf(match.opponent, now)}
      align={match.seat === 0 ? 'left' : 'right'}
    />
  )
  return (
    <div className="hud-top pointer-events-none absolute left-1/2 z-40 flex w-[min(94vw,36rem)] -translate-x-1/2 items-start gap-2">
      {match.seat === 0 ? theirCard : myCard}
      <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
        <div
          className={`btn-3d flex size-12 items-center justify-center text-xl font-bold text-white ${
            left <= 5 && match.phase !== 'countdown' ? 'bg-[#e53935]' : 'bg-[#2d6b78]'
          }`}
        >
          <span className="stroke-thin">{match.phase === 'countdown' ? 'VS' : left}</span>
        </div>
        <span
          className={`stroke-thin whitespace-nowrap rounded-md px-1.5 text-[0.7rem] font-bold text-white ${
            match.myTurn ? 'bg-[#22c55e]' : 'bg-black/45'
          }`}
        >
          {status}
        </span>
      </div>
      {match.seat === 0 ? myCard : theirCard}
    </div>
  )
}

/** Paid helpers, shown under the keypad. */
function PowerButtons({ match }) {
  const cash = useGame((s) => s.profile?.cash ?? 0)
  const use = (kind) => {
    sfx.click()
    send({ t: 'power', kind })
  }
  const revealed = match.revealed != null
  const open = CODE_LENGTH - crackedCount(match.known)
  return (
    <div className="flex w-full gap-2">
      <PowerButton
        icon="🔓"
        label="REVEAL DIGIT"
        price={DATA.powers.hint}
        disabled={revealed || open <= 1 || cash < DATA.powers.hint}
        onClick={() => use('hint')}
      />
      <PowerButton
        icon="🔍"
        label="X-RAY CODE"
        price={DATA.powers.reveal}
        disabled={revealed || cash < DATA.powers.reveal}
        onClick={() => use('reveal')}
      />
    </div>
  )
}

/** The first open (not locked) slot from `from` onwards, wrapping, that passes `test`; -1 if none. */
function findSlot(from, test) {
  for (let k = 0; k < CODE_LENGTH; k += 1) {
    const p = (from + k) % CODE_LENGTH
    if (test(p)) return p
  }
  return -1
}

/**
 * The code pad: six slots and a phone-style keypad. Used to set your own code
 * (mode 'choose') and to crack theirs (mode 'guess'). When guessing, cracked
 * digits are filled in and locked, and digits already proven wrong for the slot
 * being typed are struck off the keypad. Works with a physical keyboard too:
 * digits, Backspace, Enter, and the arrow keys.
 */
function CodePad({ match, mode }) {
  const { blur } = useSettings()
  const now = useNow(250)
  const guessing = mode === 'guess'
  const locked = guessing ? (match.revealed ? [...match.revealed] : match.known) : NO_LOCKS

  const [entry, setEntry] = useState(() => Array(CODE_LENGTH).fill(null))
  const [cursor, setCursor] = useState(0)
  const [shake, setShake] = useState(0)
  const sent = useRef(false)

  const isOpen = (p) => locked[p] == null
  const value = (p) => locked[p] ?? entry[p]
  // The slot that takes the next digit: the chosen one if it's open, else the next empty one.
  const at = cursor >= 0 && isOpen(cursor) ? cursor : findSlot(Math.max(0, cursor), (p) => isOpen(p) && entry[p] == null)
  const ruledOut = guessing && !match.revealed && at >= 0 ? match.missed[at] : ''
  const complete = SLOTS.every((p) => value(p) != null)

  const nope = () => {
    sfx.error()
    setShake((n) => n + 1)
  }

  const type = (d) => {
    if (at < 0 || ruledOut.includes(d)) return nope()
    sfx.key()
    const next = [...entry]
    next[at] = d
    setEntry(next)
    setCursor(findSlot(at + 1, (p) => isOpen(p) && next[p] == null))
  }

  const back = () => {
    // Clear the slot under the cursor if it has a digit, else the last one before it.
    let p = at >= 0 && entry[at] != null ? at : -1
    for (let q = (at < 0 ? CODE_LENGTH : at) - 1; p < 0 && q >= 0; q -= 1) {
      if (isOpen(q) && entry[q] != null) p = q
    }
    if (p < 0) return
    sfx.key()
    const next = [...entry]
    next[p] = null
    setEntry(next)
    setCursor(p)
  }

  const submit = () => {
    if (sent.current) return
    if (!complete) return nope()
    sent.current = true
    sfx.click()
    send({ t: guessing ? 'guess' : 'pick', code: SLOTS.map(value).join('') })
  }

  const randomize = () => {
    sfx.key()
    setEntry(SLOTS.map(() => String(Math.floor(Math.random() * 10))))
    setCursor(-1)
  }

  const move = (dir) => {
    const from = at < 0 ? (dir > 0 ? -1 : CODE_LENGTH) : at
    for (let p = from + dir; p >= 0 && p < CODE_LENGTH; p += dir) {
      if (isOpen(p)) return setCursor(p)
    }
    return undefined
  }

  // Physical keyboard. Re-subscribed every render so the handlers see current state.
  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat || /^(INPUT|TEXTAREA)$/.test(e.target?.tagName) || e.target?.isContentEditable) return
      if (/^[0-9]$/.test(e.key)) type(e.key)
      else if (e.key === 'Backspace') back()
      else if (e.key === 'Enter') submit()
      else if (e.key === 'ArrowLeft') move(-1)
      else if (e.key === 'ArrowRight') move(1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const left = secondsLeft(match.endsAt, now)
  const cracked = crackedCount(match.known)
  let subtitle
  if (!guessing) subtitle = 'Pick 6 digits. Your opponent will try to crack it!'
  else if (match.revealed) subtitle = 'X-Ray: you can see their code! 👀'
  else if (cracked) subtitle = `${cracked} of ${CODE_LENGTH} digits cracked. Keep going!`
  else subtitle = 'Green digits stay locked in. Red keys are ruled out.'

  return (
    <div
      className={`pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/30 ${
        blur ? 'backdrop-blur-sm' : ''
      }`}
    >
      <div className="ui-panel pop-in flex w-[min(94vw,23rem)] flex-col items-center gap-2 p-3 [@media(max-height:520px)]:w-[min(96vw,40rem)] [@media(max-height:520px)]:flex-row [@media(max-height:520px)]:items-stretch">
        <div className="flex w-full min-w-0 flex-col items-center gap-2">
          <div className="flex w-full items-center justify-between gap-2">
            <h2 className="stroke-text text-2xl font-bold leading-tight text-white">
              {guessing ? 'Crack Their Code 🔓' : 'Set Your Code 🔒'}
            </h2>
            <span
              className={`btn-3d flex size-10 shrink-0 items-center justify-center text-lg font-bold text-white ${
                left <= 5 ? 'bg-[#e53935]' : 'bg-[#2d6b78]'
              }`}
            >
              <span className="stroke-thin">{left}</span>
            </span>
          </div>
          <p className="-mt-1 w-full text-sm font-semibold leading-snug text-white/80">{subtitle}</p>

          <div key={shake} className={`flex w-full gap-1.5 ${shake ? 'row-shake' : ''}`}>
            {SLOTS.map((p) => {
              const d = value(p)
              const lockedHere = !isOpen(p)
              const isCursor = p === at
              return (
                <button
                  key={p}
                  type="button"
                  disabled={lockedHere}
                  onClick={() => {
                    sfx.key()
                    setCursor(p)
                  }}
                  className={`btn-3d studs relative flex h-14 min-w-0 flex-1 items-center justify-center ${
                    lockedHere ? 'slot-locked bg-[#22c55e]' : d != null ? 'bg-[#ffd92e]' : 'bg-[#2b3140]'
                  } ${isCursor ? 'slot-cursor' : ''}`}
                >
                  {d != null ? (
                    <span key={`${p}:${d}`} className="digit-pop stroke-text text-[2rem] font-bold leading-none text-white">
                      {d}
                    </span>
                  ) : (
                    isCursor && <span className="slot-caret stroke-text text-[2rem] font-bold leading-none text-[#3ee7ff]">_</span>
                  )}
                  {lockedHere && <span className="absolute -right-1.5 -top-2 text-sm leading-none">🔒</span>}
                </button>
              )
            })}
          </div>

          {guessing ? (
            <GuessHistory label="Your guesses" history={match.myHistory} />
          ) : (
            <button
              type="button"
              onClick={randomize}
              className="btn-3d press bg-gradient-to-b from-[#c58bff] to-[#7b3dff] px-3 py-1 text-sm font-bold text-white"
            >
              <span className="stroke-thin">🎲 Random code</span>
            </button>
          )}
          {guessing && (
            <div className="w-full [@media(max-height:520px)]:mt-auto">
              <PowerButtons match={match} />
            </div>
          )}
        </div>

        <div className="grid w-full shrink-0 grid-cols-3 gap-1.5 [@media(max-height:520px)]:w-[14rem]">
          {KEYS.map((k) => {
            if (k === 'back') {
              return (
                <button
                  key={k}
                  type="button"
                  onClick={back}
                  aria-label="Delete"
                  className="btn-3d press flex h-[clamp(2.5rem,7.5vh,3.4rem)] items-center justify-center bg-gradient-to-b from-[#ff7a7a] to-[#d81f1f] text-2xl font-bold text-white"
                >
                  <span className="stroke-text">⌫</span>
                </button>
              )
            }
            if (k === 'ok') {
              return (
                <button
                  key={k}
                  type="button"
                  onClick={submit}
                  aria-label={guessing ? 'Guess' : 'Lock in'}
                  className={`btn-3d press flex h-[clamp(2.5rem,7.5vh,3.4rem)] items-center justify-center bg-gradient-to-b from-[#5dff7a] to-[#18b84a] text-2xl font-bold text-white ${
                    complete ? 'tile-glow' : 'opacity-60'
                  }`}
                >
                  <span className="stroke-text">✔</span>
                </button>
              )
            }
            const out = ruledOut.includes(k)
            return (
              <button
                key={k}
                type="button"
                disabled={out}
                onClick={() => type(k)}
                className={`btn-3d press studs relative flex h-[clamp(2.5rem,7.5vh,3.4rem)] items-center justify-center text-[1.7rem] font-bold ${
                  out ? 'bg-[#8a2b33]' : 'bg-[#ffd92e]'
                }`}
              >
                <span className={`stroke-text relative ${out ? 'text-white/45' : 'text-white'}`}>{k}</span>
                {out && (
                  <span className="stroke-thin absolute inset-0 flex items-center justify-center text-[2rem] text-[#ff4d4d]">✖</span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** While the opponent types: your code (digits they've cracked in green) and their recent guesses. */
function DefensePanel({ match }) {
  const marks = SLOTS.map((p) => (match.theirKnown?.[p] ? 'hit' : null))
  return (
    <div className="ui-panel pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-1.5 px-3 py-1.5 portrait:bottom-16">
      <div className="flex items-center gap-2">
        <span className="stroke-thin text-sm font-bold text-white/85">Your code</span>
        <MiniCode code={match.myCode} marks={marks} />
      </div>
      <GuessHistory label="Their guesses" history={match.theirHistory} max={2} />
    </div>
  )
}

/** Quick phrases bought in the Emote Shop, said in a bubble over your head. */
function EmotePanel({ hiddenInPortrait }) {
  const owned = useGame((s) => s.profile?.ownedEmotes) || []
  const isOpen = useGame((s) => s.emotesOpen)
  const toggle = useGame((s) => s.toggleEmotes)

  return (
    <div
      className={`pointer-events-none absolute bottom-3 left-3 z-40 flex flex-col items-start gap-2 ${
        hiddenInPortrait ? 'portrait:hidden' : ''
      }`}
    >
      {isOpen && (
        <div className="ui-panel pop-in pointer-events-auto w-[15rem] p-2">
          <div className="game-scroll flex max-h-[min(30vh,14rem)] flex-col gap-1.5 overflow-y-auto pr-1">
            {owned.map((id) => {
              const e = emoteById(id)
              if (!e) return null
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    sfx.pop()
                    send({ t: 'emote', id })
                  }}
                  className="btn-3d press flex items-center justify-between bg-gradient-to-b from-[#fff35c] to-[#f2c200] px-2 py-1"
                >
                  <span className="stroke-thin truncate text-base font-bold text-white">
                    {e.label} {e.icon}
                  </span>
                  <span className="text-xs font-bold text-black/50">USE</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        className="btn-3d press pointer-events-auto bg-gradient-to-b from-[#3ee7ff] to-[#2a6bff] px-3 py-1.5 text-lg font-bold text-white"
      >
        <span className="stroke-text">Emotes 👀</span>
      </button>
    </div>
  )
}

function ResultBanner() {
  const result = useGame((s) => s.result)
  const now = useNow(250)

  useEffect(() => {
    if (!result) return undefined
    const id = setTimeout(() => useGame.setState({ result: null }), Math.max(0, result.until - Date.now()))
    return () => clearTimeout(id)
  }, [result])

  if (!result || result.until < now) return null
  const subtitle = result.win
    ? `+${money(result.reward)} 💵`
    : result.reason === 'forfeit' || result.reason === 'afk'
      ? 'You left the duel'
      : `Their code was ${result.theirCode}${result.reward ? `  ·  +${money(result.reward)} for playing` : ''}`

  return (
    <Banner className="top-[30%]">
      <div className="pop-in">
        <div
          className={`stroke-text text-[3.6rem] font-bold leading-none ${result.win ? 'text-[#ffe23d]' : 'text-[#ff4040]'}`}
        >
          {result.win ? 'CODE CRACKED! 🏆' : 'YOU GOT CRACKED 💀'}
        </div>
        <div className="stroke-text mt-2 text-2xl font-bold text-white">{subtitle}</div>
      </div>
    </Banner>
  )
}

/** Everything on screen while seated at a table: waiting, countdown, the duel. */
export function MatchUI() {
  const match = useGame((s) => s.match)
  const reveal = useGame((s) => s.reveal)
  const now = useNow(150)

  // A wood-block tick on each second of the "Starting in 3, 2, 1" countdown.
  const countdown = match?.phase === 'countdown' ? Math.max(1, secondsLeft(match.endsAt, now)) : 0
  useEffect(() => {
    if (countdown) sfx.tick()
  }, [countdown])
  const revealing = Boolean(match && reveal && reveal.until > now)
  const padOpen =
    (match?.phase === 'choosing' && match.myCode == null) ||
    (match?.phase === 'guessing' && match.myTurn && !revealing)

  return (
    <>
      {match && <EmotePanel hiddenInPortrait={padOpen} />}
      {match && !padOpen && ['countdown', 'choosing', 'guessing'].includes(match.phase) && (
        <DuelBar match={match} now={now} />
      )}

      {match?.phase === 'waiting' && (
        <div className="pointer-events-none absolute bottom-[16%] left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2">
          <span className="stroke-text whitespace-nowrap text-2xl font-bold text-white">Waiting for an opponent… (1/2)</span>
          <LeaveButton />
        </div>
      )}

      {match?.phase === 'countdown' && (
        <>
          <Banner>
            <span className="stroke-text text-[3.6rem] font-bold text-white">
              Starting in {Math.max(1, secondsLeft(match.endsAt, now))}
            </span>
          </Banner>
          <div className="pointer-events-none absolute bottom-[16%] left-1/2 z-30 -translate-x-1/2">
            <LeaveButton />
          </div>
        </>
      )}

      {match?.phase === 'choosing' && match.myCode == null && <CodePad match={match} mode="choose" />}

      {match?.phase === 'guessing' && (
        <>
          {revealing ? (
            <RevealCard reveal={reveal} />
          ) : match.myTurn ? (
            <CodePad match={match} mode="guess" />
          ) : (
            <DefensePanel match={match} />
          )}
          {!padOpen && (
            <div className="pointer-events-none absolute bottom-3 right-3 z-40">
              <LeaveButton label="Quit duel" forfeit />
            </div>
          )}
        </>
      )}

      <ResultBanner />
    </>
  )
}

export default MatchUI
