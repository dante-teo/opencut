import AVFoundation
import Foundation
import Speech

@main
struct SpeechBenchmark {
  static func main() async throws {
    let args = CommandLine.arguments
    guard SpeechTranscriber.isAvailable else {
      throw NSError(domain: "SpeechAnalyzer is unavailable on this hardware", code: 1)
    }
    let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier }.sorted()
    let installed = await SpeechTranscriber.installedLocales.map { $0.identifier }.sorted()
    if args.count == 2 && args[1] == "status" {
      try printJSON(["supported": supported, "installed": installed])
      return
    }
    guard args.count == 3 else {
      throw NSError(domain: "Use status or pass an audio file and locale", code: 1)
    }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: args[2])) else {
      throw NSError(domain: "Unsupported locale " + args[2], code: 1)
    }
    let transcriber = SpeechTranscriber(
      locale: locale, transcriptionOptions: [], reportingOptions: [],
      attributeOptions: [.audioTimeRange]
    )
    if args[1] == "install" {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
      }
      try printJSON(["installed": locale.identifier])
      return
    }
    guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
      throw NSError(domain: "SpeechAnalyzer assets are unavailable for " + locale.identifier, code: 1)
    }
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[1]))
    let analyzer = try await SpeechAnalyzer(
      inputAudioFile: file, modules: [transcriber], finishAfterFile: true
    )
    var text = ""
    var words: [[String: Any]] = []
    for try await result in transcriber.results where result.isFinal {
      text += String(result.text.characters)
      for run in result.text.runs {
        if let time = run.audioTimeRange {
          words.append([
            "text": String(result.text[run.range].characters),
            "start": time.start.seconds,
            "end": time.end.seconds,
          ])
        }
      }
    }
    await analyzer.cancelAndFinishNow()
    try printJSON(["language": locale.identifier, "text": text, "words": words])
  }

  static func printJSON(_ value: [String: Any]) throws {
    let json = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: json, as: UTF8.self))
  }
}
