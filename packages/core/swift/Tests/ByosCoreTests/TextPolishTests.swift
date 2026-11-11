import Foundation
import XCTest
@testable import ByosCore

/// Runs the vectors @byos/core's TypeScript tests use (conformance/text-polish.json).
final class TextPolishTests: XCTestCase {
    struct Name: Decodable {
        let id: String
        let expect: String
    }
    struct Repetition: Decodable {
        struct Expect: Decodable {
            let text: String
            let wasDegenerate: Bool
        }
        let name: String
        let input: String
        let expect: Expect
    }
    struct Vectors: Decodable {
        let modelNames: [Name]
        let repetition: [Repetition]
    }

    static func vectors() throws -> Vectors {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/text-polish.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testModelNamesMatchTheVectors() throws {
        for c in try Self.vectors().modelNames {
            XCTAssertEqual(ModelNames.friendly(c.id), c.expect, c.id)
        }
    }

    func testRepetitionTrimMatchesTheVectors() throws {
        for c in try Self.vectors().repetition {
            let result = RepetitionTrim.trim(c.input)
            XCTAssertEqual(result.text, c.expect.text, c.name)
            XCTAssertEqual(result.wasDegenerate, c.expect.wasDegenerate, c.name)
        }
    }
}
