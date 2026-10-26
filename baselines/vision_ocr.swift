// Apple Vision text recognition for one image; prints recognized lines as JSON.
//
//     vision-ocr IMAGE [--no-correction]
//
// Output: {"width": W, "height": H, "lines": [{"text", "confidence": 0-1, "box": [x, y, w, h]}]}
// with boxes in pixels from the top-left (Vision's are normalized, bottom-left).
// Built and called by baselines/vision.py.

import CoreGraphics
import Foundation
import ImageIO
import Vision

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: vision-ocr IMAGE [--no-correction]\n".data(using: .utf8)!)
    exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = !args.contains("--no-correction")
request.recognitionLanguages = ["en-US"]

let url = URL(fileURLWithPath: args[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write("cannot read \(args[1])\n".data(using: .utf8)!)
    exit(1)
}
let (W, H) = (Double(image.width), Double(image.height))

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write("vision: \(error)\n".data(using: .utf8)!)
    exit(1)
}

var lines: [[String: Any]] = []
for obs in request.results ?? [] {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    lines.append([
        "text": top.string,
        "confidence": Double(top.confidence),
        "box": [Double(b.minX) * W, (1 - Double(b.maxY)) * H, Double(b.width) * W, Double(b.height) * H],
    ])
}
let result: [String: Any] = ["width": W, "height": H, "lines": lines]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
