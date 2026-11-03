// Zendo icon: three rings like Zen's, but in brush and ink — ensō on rice paper.
// Rebuild (the drawing is deterministic; only the parameters below change it):
//   swiftc -O assets/make-icon.swift -o /tmp/zendo-icon && /tmp/zendo-icon assets
// Creates assets/zendo.png (1024×1024), zendo-256.png (README) and Zendo.icns (used by bin/app).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let center = CGPoint(x: 512, y: 512)

// ---- randomness: a deterministic generator and smooth noise

struct RNG {
  var s: UInt64
  mutating func next() -> Double {
    s = s &* 6364136223846793005 &+ 1442695040888963407
    return Double(s >> 11) / Double(UInt64(1) << 53)
  }
}

struct Wave { // sum of sines with random phases, roughly −1…1
  var parts: [(f: Double, p: Double, a: Double)]
  init(_ r: inout RNG, octaves: Int, base: Double) {
    var list: [(f: Double, p: Double, a: Double)] = []
    for i in 0..<octaves {
      list.append((base * pow(2.13, Double(i)), r.next() * 2 * .pi, pow(0.5, Double(i))))
    }
    parts = list
  }
  func at(_ t: Double) -> Double { parts.reduce(0) { $0 + $1.a * sin($1.f * t + $1.p) } / 1.6 }
}

func smooth(_ a: Double, _ b: Double, _ x: Double) -> Double {
  let t = max(0, min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

func bitmap(_ w: Int, _ h: Int) -> CGContext {
  CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

// ---- stroke: a ring of a hundred brush hairs; toward the end the ink runs out and the stroke dries

struct Ring {
  var radius: Double, width: Double, start: Double, sweep: Double, seed: UInt64
}

func paint(_ ctx: CGContext, _ ring: Ring) {
  var r = RNG(s: ring.seed)
  let radiusWave = Wave(&r, octaves: 3, base: 2 * .pi * 1.3)
  let widthWave = Wave(&r, octaves: 3, base: 2 * .pi * 1.7)
  let clumps = Wave(&r, octaves: 3, base: 2 * .pi * 2.5) // hair clumps across the brush width
  let drift = (r.next() - 0.5) * 18                        // the tail drifts inward or outward
  let bristles = 110
  let length = ring.radius * abs(ring.sweep)
  let steps = Int(length * 1.4)
  ctx.setFillColor(CGColor(srgbRed: 0.07, green: 0.065, blue: 0.06, alpha: 1))

  for b in 0..<bristles {
    let u = Double(b) / Double(bristles - 1) * 2 - 1 // −1 outer edge … 1 inner
    let ink = 0.80 + 0.16 * clumps.at(u) + 0.08 * (r.next() - 0.5) - 0.18 * pow(abs(u), 3)
    // rounded stroke start: the brush edges touch the paper a bit after the middle
    let begin = ring.width * 0.62 * (1 - sqrt(1 - u * u)) / length + 0.006 * r.next()
    let jitter = Wave(&r, octaves: 2, base: 2 * .pi * 4)
    let breaks = Wave(&r, octaves: 3, base: 2 * .pi * 30)
    let edge = 0.5 + 2.2 * pow(abs(u), 4)
    let dot = ring.width / Double(bristles) * 1.7

    for i in 0...steps {
      let t = Double(i) / Double(steps)
      if t < begin { continue }
      let left = ink - t + 0.07 * breaks.at(t)
      if left <= 0 { continue }
      let press = 1 + 0.28 * (1 - smooth(0, 0.07, t))   // pressure at the start
      let lift = 1 - 0.4 * smooth(0.55, 1, t)           // the brush lifts toward the end
      let w = ring.width * press * lift * (1 + 0.1 * widthWave.at(t))
      let rad = ring.radius + 5 * radiusWave.at(t) + drift * smooth(0.6, 1, t)
        - u * w / 2 + edge * jitter.at(t)
      let a = ring.start + ring.sweep * t
      ctx.setAlpha(min(1, left * 7) * 0.85)
      ctx.fillEllipse(in: CGRect(x: center.x + rad * cos(a) - dot, y: center.y + rad * sin(a) - dot,
                                 width: dot * 2, height: dot * 2))
    }
  }
  ctx.setAlpha(1)
}

// ---- paper and rings

let deg = Double.pi / 180
let rings = [
  Ring(radius: 318, width: 78, start: 232 * deg, sweep: -322 * deg, seed: 11),
  Ring(radius: 204, width: 60, start: 62 * deg, sweep: -316 * deg, seed: 23),
  Ring(radius: 96, width: 50, start: 318 * deg, sweep: -328 * deg, seed: 37),
]

let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)
let paper = CGColor(srgbRed: 0.955, green: 0.93, blue: 0.875, alpha: 1)

let ctx = bitmap(size, size)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: CGColor(gray: 0, alpha: 0.3))
ctx.addPath(tilePath)
ctx.setFillColor(paper)
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()

var noise = RNG(s: 5) // paper fibers
for _ in 0..<5000 {
  let x = 100 + noise.next() * 824, y = 100 + noise.next() * 824
  let a = noise.next() * .pi, l = 4 + noise.next() * 22
  ctx.setStrokeColor(CGColor(srgbRed: 0.55, green: 0.48, blue: 0.38, alpha: 0.035 + 0.04 * noise.next()))
  ctx.setLineWidth(0.6 + noise.next() * 0.8)
  ctx.move(to: CGPoint(x: x, y: y))
  ctx.addQuadCurve(to: CGPoint(x: x + l * cos(a), y: y + l * sin(a)),
                   control: CGPoint(x: x + l / 2 * cos(a + 0.4), y: y + l / 2 * sin(a + 0.4)))
  ctx.strokePath()
}
let vignette = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                          colors: [CGColor(srgbRed: 0.5, green: 0.4, blue: 0.28, alpha: 0),
                                   CGColor(srgbRed: 0.5, green: 0.4, blue: 0.28, alpha: 0.16)] as CFArray,
                          locations: [0.55, 1])!
ctx.drawRadialGradient(vignette, startCenter: center, startRadius: 0, endCenter: center, endRadius: 600, options: [])

// draw the ink separately and lay it on the paper with a slight bleed
let ink = bitmap(size, size)
for ring in rings { paint(ink, ring) }
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 3, color: CGColor(srgbRed: 0.1, green: 0.09, blue: 0.08, alpha: 0.55))
ctx.draw(ink.makeImage()!, in: CGRect(x: 0, y: 0, width: size, height: size))
ctx.restoreGState()

ctx.restoreGState()

// ---- files

func save(_ image: CGImage, _ path: String) {
  let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, image, nil)
  CGImageDestinationFinalize(dest)
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let master = ctx.makeImage()!
save(master, "\(out)/zendo.png")
let readme = bitmap(256, 256) // the README header
readme.interpolationQuality = .high
readme.draw(master, in: CGRect(x: 0, y: 0, width: 256, height: 256))
save(readme.makeImage()!, "\(out)/zendo-256.png")

let iconset = NSTemporaryDirectory() + "Zendo.iconset"
try? FileManager.default.removeItem(atPath: iconset)
try! FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let px = base * scale
    let small = bitmap(px, px)
    small.interpolationQuality = .high
    small.draw(master, in: CGRect(x: 0, y: 0, width: px, height: px))
    save(small.makeImage()!, "\(iconset)/icon_\(base)x\(base)\(scale == 2 ? "@2x" : "").png")
  }
}
let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconset, "-o", "\(out)/Zendo.icns"]
try! task.run()
task.waitUntilExit()
print("\(out)/zendo.png, \(out)/Zendo.icns")
