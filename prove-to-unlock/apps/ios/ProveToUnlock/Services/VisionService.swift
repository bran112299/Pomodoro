import CoreGraphics
import Foundation
import ImageIO
import ProveCore
import UIKit
import Vision

/// On-device photo analysis: Vision labels, a feature print for "is this my place?", and the
/// cross-platform dHash used for repeat detection. Nothing leaves the phone.
enum VisionService {
    struct Analysis {
        var labels: [PhotoLabel]
        var featurePrint: VNFeaturePrintObservation?
        var dhash: String
    }

    static func cgImage(_ image: UIImage) -> (CGImage, CGImagePropertyOrientation)? {
        guard let cg = image.cgImage else { return nil }
        let o: CGImagePropertyOrientation
        switch image.imageOrientation {
        case .up: o = .up
        case .down: o = .down
        case .left: o = .left
        case .right: o = .right
        case .upMirrored: o = .upMirrored
        case .downMirrored: o = .downMirrored
        case .leftMirrored: o = .leftMirrored
        case .rightMirrored: o = .rightMirrored
        @unknown default: o = .up
        }
        return (cg, o)
    }

    static func analyze(_ image: UIImage) throws -> Analysis {
        guard let (cg, orientation) = cgImage(image) else { throw NSError(domain: "ptu", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't read the photo."]) }
        let handler = VNImageRequestHandler(cgImage: cg, orientation: orientation)
        let classify = VNClassifyImageRequest()
        let print = VNGenerateImageFeaturePrintRequest()
        try handler.perform([classify, print])
        let labels = (classify.results ?? [])
            .filter { $0.confidence >= 0.05 }
            .sorted { $0.confidence > $1.confidence }
            .prefix(10)
            .map { PhotoLabel(label: $0.identifier.replacingOccurrences(of: "_", with: " "), confidence: Double($0.confidence)) }
        guard let dhash = dHash(cg) else { throw NSError(domain: "ptu", code: 2, userInfo: [NSLocalizedDescriptionKey: "Couldn't fingerprint the photo."]) }
        return Analysis(labels: Array(labels), featurePrint: print.results?.first, dhash: dhash)
    }

    /// Downscale with Core Graphics, then the same exact area-average dHash as every other device.
    static func dHash(_ cg: CGImage) -> String? {
        let maxW = 256
        let scale = min(1, Double(maxW) / Double(cg.width))
        let w = max(9, Int(Double(cg.width) * scale)), h = max(8, Int(Double(cg.height) * scale))
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        let ok: Bool = buf.withUnsafeMutableBytes { ptr in
            guard let ctx = CGContext(data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .high
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        return ok ? PhotoCheck.dHash(rgba: buf, width: w, height: h) : nil
    }

    // MARK: reference photos ("my place")

    static func referenceURL(_ key: String) -> URL { Storage.referencesDir.appendingPathComponent("\(key).bin") }

    static func saveReferences(_ prints: [VNFeaturePrintObservation], key: String) throws {
        let data = try NSKeyedArchiver.archivedData(withRootObject: prints, requiringSecureCoding: true)
        try FileManager.default.createDirectory(at: Storage.referencesDir, withIntermediateDirectories: true)
        try data.write(to: referenceURL(key), options: .atomic)
    }

    static func loadReferences(key: String) -> [VNFeaturePrintObservation] {
        guard let data = try? Data(contentsOf: referenceURL(key)) else { return [] }
        return (try? NSKeyedUnarchiver.unarchivedArrayOfObjects(ofClass: VNFeaturePrintObservation.self, from: data)) ?? []
    }

    /// 0..1, higher = more similar. Feature-print distances are ~0 for the same scene and grow
    /// towards ~2 for unrelated ones.
    static func similarity(_ p: VNFeaturePrintObservation, to refs: [VNFeaturePrintObservation]) -> Double? {
        var best: Double?
        for r in refs {
            var d: Float = 0
            if (try? p.computeDistance(&d, to: r)) != nil {
                let s = max(0, 1 - Double(d) / 2)
                best = max(best ?? 0, s)
            }
        }
        return best
    }
}
