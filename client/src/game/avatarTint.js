import { Color } from 'three'

/**
 * Colours for the far-away crowd stand-in, read from the avatar's own skin texture.
 *
 * The skin is one atlas with the face, shirt and pants already drawn on. Each body
 * part's UVs say where on it that part lives, so the average colour of the texels
 * under a part's triangles is that part's colour: head, torso, arms, legs.
 */

/** Order of the four colours in a tint array (3 floats each, linear RGB). */
export const TINT_PARTS = ['head', 'torso', 'arms', 'legs']
export const TINT_FLOATS = TINT_PARTS.length * 3

/** Texels are read from a copy of the skin at most this wide: plenty for an average. */
const SAMPLE_SIZE = 128
/** Triangles looked at per part: more adds nothing to an average. */
const MAX_TRIANGLES = 400

const _c = new Color()
/** texture -> { data, size } so a skin worn by several players is read once. */
const pixelCache = new WeakMap()

function readPixels(texture) {
  const cached = pixelCache.get(texture)
  if (cached) return cached
  const image = texture.image
  if (!image || !image.width) return null
  const size = Math.min(SAMPLE_SIZE, image.width, image.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0, size, size)
  // A texture without CORS headers taints the canvas: then there is nothing to read.
  const result = { data: ctx.getImageData(0, 0, size, size).data, size }
  pixelCache.set(texture, result)
  return result
}

/** Average sRGB colour of the texels under a geometry's triangles, or null. */
function averageColour(geometry, texture, pixels) {
  const uv = geometry.getAttribute('uv')
  if (!uv) return null
  const index = geometry.index
  const triangles = (index ? index.count : uv.count) / 3
  const step = Math.max(1, Math.floor(triangles / MAX_TRIANGLES))
  const { data, size } = pixels
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let t = 0; t < triangles; t += step) {
    let u = 0
    let v = 0
    for (let k = 0; k < 3; k += 1) {
      const i = index ? index.getX(t * 3 + k) : t * 3 + k
      u += uv.getX(i)
      v += uv.getY(i)
    }
    u /= 3
    v /= 3
    const px = Math.min(size - 1, Math.max(0, Math.floor(u * size)))
    const row = texture.flipY ? 1 - v : v
    const py = Math.min(size - 1, Math.max(0, Math.floor(row * size)))
    const o = (py * size + px) * 4
    if (data[o + 3] < 200) continue
    r += data[o]
    g += data[o + 1]
    b += data[o + 2]
    n += 1
  }
  if (!n) return null
  return [r / n / 255, g / n / 255, b / n / 255]
}

/**
 * Fills `out` (TINT_FLOATS numbers) with the avatar's head, torso, arm and leg
 * colours. Parts it cannot read keep what `out` already holds. Returns whether
 * anything was read.
 *
 * @param {object} rig from collectRig
 * @param {import('three').Texture|null} texture the skin
 * @param {Float32Array} out
 */
export function sampleTints(rig, texture, out) {
  if (!texture) return false
  let pixels = null
  try {
    pixels = readPixels(texture)
  } catch {
    return false
  }
  if (!pixels) return false

  const parts = {
    head: rig.partMeshes.head,
    torso: rig.partMeshes.torso,
    arms: rig.partMeshes.arm_L,
    legs: rig.partMeshes.leg_L,
  }
  let any = false
  TINT_PARTS.forEach((name, i) => {
    const mesh = parts[name]
    const srgb = mesh && averageColour(mesh.geometry, texture, pixels)
    if (!srgb) return
    // Instance tints multiply the lit shading in linear space.
    _c.setRGB(srgb[0], srgb[1], srgb[2], 'srgb')
    out[i * 3] = _c.r
    out[i * 3 + 1] = _c.g
    out[i * 3 + 2] = _c.b
    any = true
  })
  return any
}
