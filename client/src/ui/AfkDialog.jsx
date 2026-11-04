import { sfx } from '../audio/sfx'
import { retryConnection } from '../net/api'
import { useGame } from '../net/gameStore'

/**
 * Shown after the server removed this player for being away (see GameRoom.checkAfk).
 * No automatic rejoin: that would put an idle player straight back in a slot a
 * waiting player could use. One tap brings them back, into the fullest open lobby.
 */
export function AfkDialog() {
  const status = useGame((s) => s.status)
  if (status !== 'kicked') return null

  return (
    <div className="fade-in pointer-events-auto absolute inset-0 z-[65] flex items-center justify-center bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="afk-title"
        className="ui-panel pop-in flex w-[min(90vw,23rem)] flex-col items-center gap-3 px-5 pb-5 pt-4 text-center"
      >
        <div className="wiggle text-[3.2rem] leading-none">💤</div>
        <h2 id="afk-title" className="stroke-text text-[2rem] font-bold leading-none text-white">
          You were away
        </h2>
        <p className="text-base font-semibold leading-snug text-white/85">
          You were removed from the lobby so someone else could play. Jump back in!
        </p>
        <button
          type="button"
          autoFocus
          onClick={() => {
            sfx.click()
            retryConnection()
          }}
          className="btn-3d press mt-1 w-full bg-gradient-to-b from-[#5dff7a] to-[#18b84a] px-2 py-2 text-xl font-bold text-white"
        >
          <span className="stroke-text">Play again</span>
        </button>
      </div>
    </div>
  )
}

export default AfkDialog
