import { useFrame } from '@react-three/fiber'
import { memo, Suspense, useLayoutEffect, useRef, useState } from 'react'
import {
  BufferAttribute,
  CanvasTexture,
  Color,
  InstancedBufferAttribute,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
} from 'three'

import { DEFAULT_PROPORTIONS } from '../bloxity/store'
import { useGame } from '../net/gameStore'
import {
  avatarAnchors,
  avatarRegistry,
  hiddenUntil,
  localPlayer,
  remoteEmotes,
  remotes,
  remoteSeats,
} from '../net/liveState'
import { mergedBoxes } from './instancing'
import Nametag from './Nametag'
import { PLAYER_HEIGHT } from './layout'
import PlayerAvatar from './PlayerAvatar'
import { getSettings } from './quality'
import { TINT_FLOATS } from './avatarTint'
import { skipWhenHidden } from './sceneGraph'
import { clearSeatPose, poseAtSeat } from './seatPose'
import { useDisposable } from './useDisposable'

/** One snapshot interval: interpolation always runs one packet behind. */
const INTERP_S = 0.1
const MAX_PLAYERS = 20

/** The nearest few players are always drawn as full avatars, budget or not. */
const ALWAYS_FULL = 2
/** A player already drawn in full counts as this much nearer, so two at the same distance don't flicker. */
const STAY_FULL = 0.85
/** Height of the crowd stand-in figure (see createProxyGeometry). */
const PROXY_HEIGHT = 2.11
/** Within this distance an avatar also draws its hand and shoe items (a little further to turn them off again). */
const DETAIL_ON = 8
const DETAIL_OFF = 10
/** Beyond these distances an avatar's bones update every 2nd / 3rd frame. */
const STEP2_DISTANCE = 16
const STEP3_DISTANCE = 30

/** id -> { group, visual, full, active, hidden, isFull, dist, rank, headRef, costRef, tint } */
const registry = avatarRegistry
const ordered = []
const byRank = (a, b) => a.rank - b.rank

const _obj = new Object3D()
const _color = new Color()

function lerpAngle(a, b, t) {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/**
 * Stand-in colours until the avatar's own skin has been read: a skin tone for head
 * and arms, and a stable pastel per player id for shirt and trousers.
 */
function fillDefaultTint(id, out) {
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const set = (i, c) => {
    out[i * 3] = c.r
    out[i * 3 + 1] = c.g
    out[i * 3 + 2] = c.b
  }
  set(0, _color.set('#d9a77a'))
  set(1, _color.setHSL((h % 360) / 360, 0.55, 0.62))
  set(2, _color.set('#d9a77a'))
  set(3, _color.setHSL((h % 360) / 360, 0.4, 0.38))
  return out
}

/** Blocky stand-in figure with per-part shading baked into vertex colours. */
function createProxyGeometry() {
  const parts = [
    { size: [0.36, 0.8, 0.4], at: [-0.2, 0.4, 0], shade: 0.45 },
    { size: [0.36, 0.8, 0.4], at: [0.2, 0.4, 0], shade: 0.45 },
    { size: [0.8, 0.8, 0.42], at: [0, 1.2, 0], shade: 0.9 },
    { size: [0.3, 0.8, 0.36], at: [-0.56, 1.2, 0], shade: 0.75 },
    { size: [0.3, 0.8, 0.36], at: [0.56, 1.2, 0], shade: 0.75 },
    { size: [0.5, 0.5, 0.5], at: [0, 1.86, 0], shade: 1 },
  ]
  const geometry = mergedBoxes(parts)
  const count = geometry.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  // Which tint each box takes: 0 legs, 1 torso, 2 arms, 3 head (see the material).
  const partIds = new Float32Array(count)
  const tintOf = [0, 0, 1, 2, 2, 3]
  // mergedBoxes keeps part order and a BoxGeometry has 24 vertices.
  parts.forEach((part, i) => {
    for (let v = i * 24; v < (i + 1) * 24; v += 1) {
      colors.fill(part.shade, v * 3, v * 3 + 3)
      partIds[v] = tintOf[i]
    }
  })
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.setAttribute('aPart', new BufferAttribute(partIds, 1))
  // One colour per body part per stand-in (written every frame from each player's tint).
  for (const name of TINT_NAMES) geometry.setAttribute(name, new InstancedBufferAttribute(new Float32Array(MAX_PLAYERS * 3), 3))
  return geometry
}

const TINT_NAMES = ['tintHead', 'tintTorso', 'tintArms', 'tintLegs']

/**
 * Lit material for the crowd: each box is shaded by its vertex colour and tinted by
 * the player's colour for that part, so one instanced draw call shows 19 different
 * outfits.
 */
function createProxyMaterial() {
  const material = new MeshLambertMaterial({ vertexColors: true })
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aPart;
attribute vec3 tintHead;
attribute vec3 tintTorso;
attribute vec3 tintArms;
attribute vec3 tintLegs;`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
vColor.rgb *= aPart < 0.5 ? tintLegs : (aPart < 1.5 ? tintTorso : (aPart < 2.5 ? tintArms : tintHead));`,
      )
  }
  return material
}

function createBlobTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(0,0,0,0.45)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new CanvasTexture(canvas)
}

const RemotePlayer = memo(function RemotePlayer({ meta }) {
  const { id } = meta
  const groupRef = useRef(null)
  const visualRef = useRef(null)
  const fullRef = useRef(null)
  const tagRef = useRef(null)
  /** Set by RemotePlayers each frame: is this one of the nearest few whose tag shows? */
  const [tagGate] = useState(() => ({ show: true }))
  // Offset idle animations so a seated crowd doesn't breathe in unison.
  const motionRef = useRef({ time: id.length * 1.7, speed: 0, grounded: true, maxSpeed: 7, seated: false })
  /** Top of this player's head, draw calls as a full avatar (null until measured), stand-in colours. */
  const headRef = useRef(PLAYER_HEIGHT)
  const costRef = useRef(null)
  const [tint] = useState(() => fillDefaultTint(id, new Float32Array(TINT_FLOATS)))
  const tintRef = useRef(tint)

  useLayoutEffect(() => {
    const entry = {
      group: groupRef.current,
      visual: visualRef.current,
      full: fullRef.current,
      active: false,
      hidden: false,
      isFull: false,
      detail: true,
      dist: 0,
      rank: 0,
      id,
      tagGate,
      headRef,
      costRef,
      tint,
    }
    // Hidden avatars (no data yet, or drawn as a crowd stand-in) cost nothing.
    skipWhenHidden(groupRef.current)
    skipWhenHidden(fullRef.current)
    registry.set(id, entry)
    avatarAnchors.set(id, visualRef.current)
    visualRef.current.userData.headRef = headRef
    return () => {
      registry.delete(id)
      avatarAnchors.delete(id)
    }
  }, [id, tagGate, headRef, costRef, tint])

  useFrame((_state, delta) => {
    const group = groupRef.current
    const visual = visualRef.current
    const entry = registry.get(id)
    if (!group || !entry) return

    const r = remotes.get(id)
    const seat = remoteSeats.get(id)
    if (!r && !seat) {
      group.visible = false
      entry.active = false
      return
    }
    group.visible = true
    entry.active = true
    entry.hidden = (hiddenUntil.get(id) || 0) > Date.now()

    const m = motionRef.current
    m.time += delta
    // Far-away players animate every 2nd / 3rd frame (see PlayerAvatar).
    m.step = entry.dist > STEP3_DISTANCE ? 3 : entry.dist > STEP2_DISTANCE ? 2 : 1
    m.detail = entry.detail
    // A Bloxity emote plays until that player moves or sits (or the clip ends).
    const emote = remoteEmotes.get(id)
    if (emote && (seat || emote.done || (r && r.s > 0.5))) remoteEmotes.delete(id)
    m.emote = remoteEmotes.get(id) || null

    if (seat) {
      group.position.set(seat.x, 0, seat.z)
      poseAtSeat(visual, tagRef.current, seat, m, delta)
    } else {
      if (m.seated || m.danceT != null) clearSeatPose(visual, tagRef.current, m)
      r.alpha = Math.min(1, r.alpha + delta / INTERP_S)
      r.x = r.fx + (r.tx - r.fx) * r.alpha
      r.y = r.fy + (r.ty - r.fy) * r.alpha
      r.z = r.fz + (r.tz - r.fz) * r.alpha
      r.ry = lerpAngle(r.fry, r.try, r.alpha)
      group.position.set(r.x, r.y, r.z)
      visual.rotation.y = r.ry
      m.speed = r.s
      m.grounded = r.g
    }
  })

  return (
    <group ref={groupRef} visible={false}>
      <group ref={visualRef}>
        <group ref={fullRef} visible={false}>
          <Suspense fallback={null}>
            <PlayerAvatar
              equipped={meta.equipped ?? null}
              proportions={meta.proportions || DEFAULT_PROPORTIONS}
              silent
              castShadow={false}
              targetHeight={PLAYER_HEIGHT}
              motionRef={motionRef}
              headRef={headRef}
              costRef={costRef}
              tintRef={tintRef}
            />
          </Suspense>
        </group>
      </group>
      <group ref={tagRef}>
        <Nametag id={id} name={meta.name} streak={meta.streak} title={meta.title} gate={tagGate} headRef={headRef} />
      </group>
    </group>
  )
})

/**
 * Everyone else in the room.
 *
 * LOD, nearest first: players within the preset's `fullDistance` are drawn as full
 * Bloxity avatars until their draw calls (1 for the body plus 1 per worn item mesh,
 * measured by PlayerAvatar) add up to the preset's `avatarBudget`. Plain avatars are
 * cheap, so on a typical server nearly everyone is full; heavily dressed ones use the
 * budget up sooner. The rest are one instanced blocky crowd mesh coloured like each
 * player (head, torso, arms, legs read from their skin), and everyone gets an
 * instanced blob shadow, so the crowd and shadows cost 2 draw calls in all.
 */
export function RemotePlayers() {
  const players = useGame((s) => s.players)
  const selfId = useGame((s) => s.selfId)
  const proxyRef = useRef(null)
  const blobRef = useRef(null)

  const res = useDisposable(() => {
    const blobTexture = createBlobTexture()
    return {
      proxyGeometry: createProxyGeometry(),
      proxyMaterial: createProxyMaterial(),
      blobTexture,
      blobGeometry: new PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2),
      blobMaterial: new MeshBasicMaterial({
        map: blobTexture,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    }
  }, [])

  useLayoutEffect(() => {
    proxyRef.current.count = 0
    blobRef.current.count = 0
  }, [])

  useFrame(() => {
    const proxy = proxyRef.current
    const blob = blobRef.current
    const settings = getSettings()

    ordered.length = 0
    for (const e of registry.values()) {
      if (!e.active) {
        e.full.visible = false
        e.isFull = false
        continue
      }
      e.dist = Math.hypot(e.group.position.x - localPlayer.position.x, e.group.position.z - localPlayer.position.z)
      e.rank = e.isFull ? e.dist * STAY_FULL : e.dist
      e.detail = e.dist < (e.detail ? DETAIL_OFF : DETAIL_ON)
      ordered.push(e)
    }
    ordered.sort(byRank)

    const headTints = proxy.geometry.getAttribute('tintHead')
    const torsoTints = proxy.geometry.getAttribute('tintTorso')
    const armTints = proxy.geometry.getAttribute('tintArms')
    const legTints = proxy.geometry.getAttribute('tintLegs')

    let proxies = 0
    let blobs = 0
    let spent = 0
    let fulls = 0
    let budgetLeft = true
    for (let i = 0; i < ordered.length; i += 1) {
      const e = ordered[i]
      e.tagGate.show = i < settings.maxNames
      if (e.hidden) {
        // Broken apart after a loss: nothing of them is drawn, and they cost nothing.
        e.full.visible = false
        e.isFull = false
        continue
      }

      // Full avatar while it is close, built, and the draw-call budget lasts. Nearest
      // first; once the budget runs out everyone further is a stand-in.
      const costs = e.costRef.current
      const cost = costs && (e.detail ? costs.near : costs.far)
      let full = costs !== null && budgetLeft && e.dist < settings.fullDistance && fulls < settings.maxFullAvatars
      if (full && fulls >= ALWAYS_FULL && spent + cost > settings.avatarBudget) {
        full = false
        budgetLeft = false
      }
      if (full) {
        spent += cost
        fulls += 1
      }
      e.isFull = full
      e.full.visible = full

      if (!full) {
        _obj.position.copy(e.group.position)
        _obj.rotation.set(0, e.visual.rotation.y, 0)
        _obj.scale.setScalar(e.headRef.current / PROXY_HEIGHT)
        _obj.updateMatrix()
        proxy.setMatrixAt(proxies, _obj.matrix)
        const t = e.tint
        headTints.setXYZ(proxies, t[0], t[1], t[2])
        torsoTints.setXYZ(proxies, t[3], t[4], t[5])
        armTints.setXYZ(proxies, t[6], t[7], t[8])
        legTints.setXYZ(proxies, t[9], t[10], t[11])
        proxies += 1
      }

      _obj.position.set(e.group.position.x, 0.02, e.group.position.z)
      _obj.rotation.set(0, 0, 0)
      _obj.updateMatrix()
      blob.setMatrixAt(blobs, _obj.matrix)
      blobs += 1
    }

    // Without realtime shadows the local player gets a blob too.
    if (!settings.shadows && Date.now() >= localPlayer.hiddenUntil) {
      _obj.position.set(localPlayer.position.x, 0.02, localPlayer.position.z)
      _obj.rotation.set(0, 0, 0)
      _obj.updateMatrix()
      blob.setMatrixAt(blobs, _obj.matrix)
      blobs += 1
    }

    proxy.count = proxies
    blob.count = blobs
    // An instanced mesh with nothing to draw still costs a draw call.
    proxy.visible = proxies > 0
    blob.visible = blobs > 0
    if (proxies) {
      proxy.instanceMatrix.needsUpdate = true
      headTints.needsUpdate = true
      torsoTints.needsUpdate = true
      armTints.needsUpdate = true
      legTints.needsUpdate = true
    }
    if (blobs) blob.instanceMatrix.needsUpdate = true
  })

  return (
    <>
      {Object.values(players)
        .filter((p) => p.id !== selfId)
        .map((p) => (
          <RemotePlayer key={p.id} meta={p} />
        ))}
      {/* Crowd instances move every frame; their bounds are not worth recomputing. */}
      <instancedMesh ref={proxyRef} args={[res.proxyGeometry, res.proxyMaterial, MAX_PLAYERS]} frustumCulled={false} />
      <instancedMesh ref={blobRef} args={[res.blobGeometry, res.blobMaterial, MAX_PLAYERS + 1]} frustumCulled={false} />
    </>
  )
}

export default RemotePlayers
