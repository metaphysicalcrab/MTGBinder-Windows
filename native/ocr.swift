// Binder's OCR helper (spec §5.1.4): reads one JSON request per line on stdin, {"id": "...", "path": "..."}, runs
// Apple Vision text recognition on that image, and writes one JSON response per line on stdout:
// {"id": "...", "width": 672, "height": 936, "lines": [{"text": "...", "confidence": 0.98,
//   "box": {"x": 0.06, "y": 0.04, "w": 0.5, "h": 0.04}}]}
// Boxes are normalized to the image with the origin at the top left. Failures answer {"id": "...", "error": "..."}.
// Built by `pnpm setup` (swiftc -O native/ocr.swift -o bin/ocr); the server starts it once and keeps it running.
import Foundation
import ImageIO
import Vision

struct Request: Decodable {
  let id: String
  let path: String
}

struct Box: Encodable {
  let x: Double
  let y: Double
  let w: Double
  let h: Double
}

struct Line: Encodable {
  let text: String
  let confidence: Double
  let box: Box
}

struct Result: Encodable {
  let id: String
  let width: Int
  let height: Int
  let lines: [Line]
}

struct Failure: Encodable {
  let id: String
  let error: String
}

let encoder = JSONEncoder()

/// Writes one answer line. Returns false when the value can't be encoded (a NaN confidence or box, say).
@discardableResult
func send<T: Encodable>(_ value: T) -> Bool {
  guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else { return false }
  FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
  return true
}

/// How the image is decoded: upright, with its EXIF orientation applied (a phone can store a photo sideways), and at
/// most 4096 px on its long side, so a huge photo doesn't take Vision past the timeout. A smaller one is left as it is.
let decoding = [
  kCGImageSourceCreateThumbnailFromImageAlways: true,
  kCGImageSourceCreateThumbnailWithTransform: true,
  kCGImageSourceThumbnailMaxPixelSize: 4096,
  kCGImageSourceShouldCacheImmediately: true,
] as CFDictionary

func recognize(_ request: Request) -> Result? {
  let url = URL(fileURLWithPath: request.path)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
    let image = CGImageSourceCreateThumbnailAtIndex(source, 0, decoding)
  else {
    send(Failure(id: request.id, error: "Can't read an image at \(request.path)"))
    return nil
  }
  let vision = VNRecognizeTextRequest()
  vision.recognitionLevel = .accurate
  vision.usesLanguageCorrection = false
  vision.recognitionLanguages = ["en-US"]
  // Collector lines are about 1.5% of a card's height, under Vision's default minimum text height.
  vision.minimumTextHeight = 0
  do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([vision])
  } catch {
    send(Failure(id: request.id, error: "Text recognition failed: \(error.localizedDescription)"))
    return nil
  }
  let lines: [Line] = (vision.results ?? []).compactMap { observation in
    guard let best = observation.topCandidates(1).first else { return nil }
    let b = observation.boundingBox  // normalized, origin at the bottom left
    return Line(
      text: best.string,
      confidence: Double(best.confidence),
      box: Box(x: b.minX, y: 1 - b.maxY, w: b.width, h: b.height))
  }
  return Result(id: request.id, width: image.width, height: image.height, lines: lines)
}

while let input = readLine() {
  guard let data = input.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data) else {
    send(Failure(id: "", error: "Not a request: \(input.prefix(200))"))
    continue
  }
  if let result = recognize(request), !send(result) {
    send(Failure(id: request.id, error: "The text Vision read couldn't be encoded"))
  }
}
