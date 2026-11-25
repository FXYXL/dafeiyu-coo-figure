/** Convert DeepFish's body transform (model coordinates, Y up) to kit logo coordinates (Y down).
 * matrix maps model coordinates to WebGL NDC before the kit SVG transform.
 * The native anchor is -0.92 model units; ViewX is also in model units, not window-width units.
 */
export function musicTransform({ matrix: m, roll, vx, vy = 0, anchorY = -0.92, anchorScale = 1.7, nativeModelScale = 1 }) {
  const sx = m[0] * 128, sy = m[5] * 128;
  if (Math.abs(sx - sy) > 1e-3) throw new Error('Music audit expects an isotropic model projection');
  const modelAnchor = anchorY / nativeModelScale;
  const pivot = { x: (m[4] * modelAnchor + m[12] + 1) * 128, y: (1 - m[5] * modelAnchor - m[13]) * 128 };
  const angle = -roll;
  const rad = angle * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
  const dx = pivot.x - 128, dy = pivot.y - 256;
  return {
    angle,
    x: vx * anchorScale * sx / nativeModelScale + (1 - c) * dx + s * dy,
    y: -vy * anchorScale * sy / nativeModelScale - s * dx + (1 - c) * dy,
    pivot,
  };
}
